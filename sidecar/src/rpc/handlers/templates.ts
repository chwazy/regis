import { join } from 'node:path';
import { z } from 'zod';
import { RpcErrorCode, type Entity, type Job, type Template } from '@regis/shared';
import type { StartJobInput } from '../../jobs/runner';
import { NoEligibleAgentError } from '../../routing/engine';
import type { DecideRoute } from '../../routing/service';
import { detectVariables, TemplateFormatError } from '../../templates/detect';
import { mergeVariables, parseStoredVariables, type TemplateVariable } from '../../templates/sources';
import type { TemplateStore } from '../../templates/store';
import { RpcMethodError, type MethodHandler } from '../server';

export const MODELS_FOLDER = ['library', 'models'] as const;

export interface TemplatesHandlerDeps {
  store: TemplateStore;
  getDataDir: () => Promise<string>;
  getEntity: (entityId: string) => Promise<Entity | undefined>;
  route: DecideRoute;
  runner: { start: (input: StartJobInput) => Promise<Job> };
  pdfAvailable: () => Promise<boolean>;
}

const detectParams = z.object({ templateId: z.string().min(1) });
const generateParams = z.object({
  templateId: z.string().min(1),
  entityId: z.string().min(1),
  toPdf: z.boolean().optional(),
});

const SOURCE_LABELS: Record<TemplateVariable['source'], string> = {
  brain: 'brain (read it with brain_get_entity / brain_search)',
  odoo: 'odoo (read it with the Odoo tools; never compute or estimate it)',
  agent: 'agent (write it yourself)',
  ask: 'ask (ask the user; do not invent it)',
};

function parseParams<T>(schema: z.ZodType<T>, params: unknown): T {
  const parsed = schema.safeParse(params ?? {});
  if (!parsed.success) {
    throw new RpcMethodError(RpcErrorCode.InvalidParams, parsed.error.message);
  }
  return parsed.data;
}

export function buildGeneratePrompt(
  template: Template,
  variables: TemplateVariable[],
  entity: Entity,
  toPdf = false,
): string {
  return [
    `Fill the document template "${template.name}" for ${entity.kind} "${entity.name}" (entity id: ${entity.id}). Answer in French.`,
    'You only provide values for the template variables. The fixed text of the template (terms and conditions, legal text) is kept as is by the tool and must never be rewritten.',
    'Amounts, hours and counts must come from the data (Odoo tools, brain facts), never from your own estimate. If a value is unavailable, leave the variable out rather than guessing.',
    `Template id: ${template.id}`,
    template.instructions.trim() === ''
      ? 'Template instructions: none.'
      : `Template instructions:\n${template.instructions.trim()}`,
    'Variables and their source:',
    ...variables.map((variable) => `- ${variable.key}: ${SOURCE_LABELS[variable.source]}`),
    `When the values are ready, call the tool mcp__regis__render_template once with { "templateId": "${template.id}", "entityId": "${entity.id}", ${toPdf ? '"toPdf": true, ' : ''}"values": { "<variable>": "<value>" } }.`,
    'Then reply with the generated file ids and the list of variables left empty.',
  ].join('\n');
}

export function createTemplatesMethods(deps: TemplatesHandlerDeps): Record<string, MethodHandler> {
  const detect = async (
    templateId: string,
  ): Promise<{ template: Template; variables: TemplateVariable[] }> => {
    const template = await deps.store.getTemplate(templateId).catch(() => {
      throw new RpcMethodError(RpcErrorCode.InvalidParams, 'Modèle introuvable');
    });
    const file = await deps.store.getFile(template.fileId);
    const filePath = join(await deps.getDataDir(), ...MODELS_FOLDER, file.relPath);
    let keys: string[];
    try {
      keys = await detectVariables(filePath);
    } catch (error) {
      if (error instanceof TemplateFormatError) {
        throw new RpcMethodError(RpcErrorCode.InvalidParams, error.message);
      }
      throw error;
    }
    const variables = mergeVariables(template.variablesJson, keys);
    const previous = parseStoredVariables(template.variablesJson);
    const changed =
      previous.length !== variables.length ||
      previous.some((variable, index) => variable.key !== variables[index]?.key);
    const updated = await deps.store.updateTemplate(template.id, {
      variablesJson: variables,
      ...(changed ? { version: template.version + 1 } : {}),
    });
    return { template: updated, variables };
  };

  return {
    'templates.detect': async (params) => {
      const { templateId } = parseParams(detectParams, params);
      const { variables } = await detect(templateId);
      return { variables };
    },
    'templates.capabilities': async () => ({ pdf: await deps.pdfAvailable() }),
    'templates.generate': async (params): Promise<Job> => {
      const { templateId, entityId, toPdf } = parseParams(generateParams, params);
      const entity = await deps.getEntity(entityId);
      if (!entity) {
        throw new RpcMethodError(RpcErrorCode.InvalidParams, 'Entité introuvable');
      }
      const { template, variables } = await detect(templateId);
      const prompt = buildGeneratePrompt(
        template,
        variables,
        entity,
        toPdf === true && (await deps.pdfAvailable()),
      );
      try {
        const decision = await deps.route({
          task: prompt,
          taskType: 'redaction',
          source: 'template',
          contextRefs: [
            { type: 'entity', id: entity.id },
            { type: 'template', id: template.id },
          ],
        });
        return await deps.runner.start({
          agentId: decision.agentId,
          routingReason: decision.reason,
          title: `${template.name} — ${entity.name}`,
          prompt,
          contextRefs: [
            { type: 'entity', id: entity.id },
            { type: 'template', id: template.id },
          ],
        });
      } catch (error) {
        if (error instanceof NoEligibleAgentError) {
          throw new RpcMethodError(RpcErrorCode.Unavailable, error.message);
        }
        throw error;
      }
    },
  };
}

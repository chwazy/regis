import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  renderTemplate,
  TemplateRenderError,
  type RenderInput,
  type RenderResult,
} from '../templates/render';

export const REGIS_RENDER_TEMPLATE_TOOL = 'mcp__regis__render_template';

export const renderTemplateInputShape = {
  templateId: z.string().min(1),
  values: z.record(z.string(), z.union([z.string(), z.number()])),
  entityId: z.string().min(1).optional(),
  toPdf: z.boolean().optional(),
};

const renderArguments = z.object(renderTemplateInputShape);

export interface TemplateToolContext {
  jobId: string;
  agentId: string;
}

export interface TemplateToolResult {
  isError: boolean;
  payload: unknown;
}

export interface TemplateTools {
  render: (context: TemplateToolContext, args: unknown) => Promise<TemplateToolResult>;
}

export interface TemplateToolsDeps {
  render?: (input: RenderInput) => Promise<RenderResult>;
}

const refuse = (message: string): TemplateToolResult => ({ isError: true, payload: { error: message } });

export function createTemplateTools(deps: TemplateToolsDeps = {}): TemplateTools {
  const render = deps.render ?? renderTemplate;
  return {
    async render(context, args) {
      const parsed = renderArguments.safeParse(args);
      if (!parsed.success) {
        return refuse(`Paramètres invalides : ${parsed.error.message}`);
      }
      if (context.jobId === '') {
        return refuse('Job appelant inconnu');
      }
      try {
        const result = await render({
          templateId: parsed.data.templateId,
          values: parsed.data.values,
          jobId: context.jobId,
          ...(parsed.data.entityId === undefined ? {} : { entityId: parsed.data.entityId }),
          ...(parsed.data.toPdf === undefined ? {} : { toPdf: parsed.data.toPdf }),
        });
        return { isError: false, payload: result };
      } catch (error) {
        if (error instanceof TemplateRenderError) {
          return refuse(error.message);
        }
        return refuse(`Rendu impossible : ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}

export function registerTemplateTools(
  mcp: McpServer,
  context: TemplateToolContext,
  tools: TemplateTools,
): void {
  mcp.registerTool(
    'render_template',
    {
      description:
        'Fills a document template with variable values and saves the result in the Régis library. Provide only values for the template variables; the fixed text of the template is kept as is. Returns the generated file ids and the variables left without a value.',
      inputSchema: renderTemplateInputShape,
    },
    async (args) => {
      const result = await tools.render(context, args);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.payload) }],
        ...(result.isError ? { isError: true } : {}),
      };
    },
  );
}

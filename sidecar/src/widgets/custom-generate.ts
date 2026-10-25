import {
  CUSTOM_NUMERIC_FIELDS,
  CustomWidgetSpec,
  customFieldsOf,
  customSpecFieldErrors,
  type CustomItemKind,
} from '@regis/shared';
import type { Job } from '@regis/shared';
import type { StartJobInput } from '../jobs/runner';
import type { DecideRoute } from '../routing/service';

export class CustomWidgetFormatError extends Error {}

const GENERATION_JOB_TIMEOUT_MS = 300_000;
const MAX_ATTEMPTS = 2;
const ITEM_KINDS = CustomWidgetSpec.shape.itemKind.options;

export function parseCustomWidgetText(text: string | null): CustomWidgetSpec {
  if (text === null || text.trim() === '') {
    throw new CustomWidgetFormatError('Réponse de l’agent vide');
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) {
    throw new CustomWidgetFormatError('Réponse de l’agent sans objet JSON');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch (error) {
    throw new CustomWidgetFormatError(
      `Réponse de l’agent illisible : ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = CustomWidgetSpec.safeParse(raw);
  if (!parsed.success) {
    throw new CustomWidgetFormatError(`Définition invalide : ${parsed.error.message}`);
  }
  const fieldErrors = customSpecFieldErrors(parsed.data);
  if (fieldErrors.length > 0) {
    throw new CustomWidgetFormatError(`Définition invalide : ${fieldErrors.join(' ; ')}`);
  }
  return parsed.data;
}

export function buildCustomWidgetPrompt(description: string, retryReason?: string): string {
  const fieldsByKind = Object.fromEntries(
    ITEM_KINDS.map((kind: CustomItemKind) => [kind, customFieldsOf(kind)]),
  );
  return [
    'You define a dashboard widget for Régis, a personal command hub, from a French description. Answer with data only.',
    'The widget is a declarative query over the local cache of items, executed by fixed code. Never write SQL, JavaScript or a shell command.',
    'Reply with a single JSON object and nothing else, with exactly this shape:',
    '{"title": string (max 60 chars, French), "itemKind": one of ' +
      JSON.stringify(ITEM_KINDS) +
      ', "filters": [{"field": string, "op": "eq" | "neq" | "gt" | "lt" | "contains" | "within_days", "value": string | number | boolean}] (max 5), "groupBy"?: string, "aggregate": {"fn": "count" | "sum", "field"?: string}, "render": "list" | "kv" | "bar", "limit": integer 1..50}',
    'Use ONLY the field names allowed for the chosen itemKind, listed below. "sum" needs one of these numeric fields: ' +
      CUSTOM_NUMERIC_FIELDS.join(', ') +
      '.',
    '"within_days" applies to date fields (occurredAt, updatedAt, data.end, data.dueDate, data.dateStart, data.dateEnd) and takes a number of days from today (negative = past). Dates are ISO text, booleans are true/false.',
    'Never output a figure of your own: the numbers are computed from the data.',
    ...(retryReason
      ? [`Your previous answer was rejected (${retryReason}). Reply with valid JSON only.`]
      : []),
    'Allowed fields by itemKind:',
    JSON.stringify(fieldsByKind),
    'Description:',
    JSON.stringify(description),
  ].join('\n');
}

export interface CustomWidgetGeneratorDeps {
  route: DecideRoute;
  runner: {
    start: (input: StartJobInput) => Promise<Job>;
    waitForEnd: (jobId: string, timeoutMs?: number) => Promise<Job>;
  };
  failJob: (jobId: string, error: string) => Promise<void>;
}

export function createCustomWidgetGenerator(
  deps: CustomWidgetGeneratorDeps,
): (description: string) => Promise<CustomWidgetSpec> {
  return async (description) => {
    let reason: string | undefined;
    for (let index = 0; index < MAX_ATTEMPTS; index += 1) {
      const prompt = buildCustomWidgetPrompt(description, reason);
      const decision = await deps.route({ task: prompt, taskType: 'other', source: 'custom-widget' });
      const started = await deps.runner.start({
        agentId: decision.agentId,
        title: 'Widget sur mesure',
        prompt,
        kind: 'extract',
        routingReason: decision.reason,
      });
      const job = await deps.runner.waitForEnd(started.id, GENERATION_JOB_TIMEOUT_MS);
      if (job.status !== 'done') {
        throw new CustomWidgetFormatError(job.error ?? `Le job s’est terminé en ${job.status}`);
      }
      try {
        return parseCustomWidgetText(job.resultText);
      } catch (error) {
        if (!(error instanceof CustomWidgetFormatError)) {
          throw error;
        }
        await deps.failJob(job.id, error.message);
        if (index === MAX_ATTEMPTS - 1) {
          throw error;
        }
        reason = error.message;
      }
    }
    throw new CustomWidgetFormatError('Aucune définition générée');
  };
}

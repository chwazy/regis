import { z } from 'zod';
import { RpcErrorCode, type Item, type Job, type MinutesExportResult } from '@regis/shared';
import type { MinutesContext } from '../../minutes/prompt';
import { minutesTemplateValues } from '../../minutes/render';
import { MinutesFormatError, parseMinutesOutput } from '../../minutes/schema';
import { MinutesJobError } from '../../minutes/service';
import { NoEligibleAgentError } from '../../routing/engine';
import type { RenderInput, RenderResult } from '../../templates/render';
import { RpcMethodError, type MethodHandler } from '../server';

export interface MinutesHandlerDeps {
  generate: (transcriptItemId: string) => Promise<Item>;
  getNote: (itemId: string) => Promise<Item | undefined>;
  getJob: (jobId: string) => Promise<Job>;
  context: (transcriptItemId: string) => Promise<MinutesContext>;
  timezone: () => Promise<string>;
  agentName: (agentId: string) => Promise<string>;
  render: (input: RenderInput) => Promise<RenderResult>;
}

const generateParams = z.object({ transcriptItemId: z.string().min(1) });
const exportParams = z.object({ minutesItemId: z.string().min(1), templateId: z.string().min(1) });
const MinutesNoteData = z.looseObject({ jobId: z.string().min(1), agentId: z.string().min(1) });
const EXTERNAL_PREFIX = 'minutes:';

function parseParams<T>(schema: z.ZodType<T>, params: unknown): T {
  const parsed = schema.safeParse(params ?? {});
  if (!parsed.success) {
    throw new RpcMethodError(RpcErrorCode.InvalidParams, parsed.error.message);
  }
  return parsed.data;
}

export function createMinutesMethods(deps: MinutesHandlerDeps): Record<string, MethodHandler> {
  return {
    'minutes.generate': async (params): Promise<Item> => {
      const { transcriptItemId } = parseParams(generateParams, params);
      try {
        return await deps.generate(transcriptItemId);
      } catch (error) {
        if (error instanceof NoEligibleAgentError) {
          throw new RpcMethodError(RpcErrorCode.Unavailable, error.message);
        }
        if (error instanceof MinutesFormatError || error instanceof MinutesJobError) {
          throw new RpcMethodError(RpcErrorCode.Unavailable, error.message);
        }
        throw error;
      }
    },
    'minutes.export': async (params): Promise<MinutesExportResult> => {
      const { minutesItemId, templateId } = parseParams(exportParams, params);
      const note = await deps.getNote(minutesItemId);
      const data = MinutesNoteData.safeParse(note?.dataJson);
      if (!note || !note.externalId.startsWith(EXTERNAL_PREFIX) || !data.success) {
        throw new RpcMethodError(RpcErrorCode.InvalidParams, 'PV introuvable');
      }
      const job = await deps.getJob(data.data.jobId);
      if (job.resultText === null) {
        throw new RpcMethodError(RpcErrorCode.InvalidParams, 'Le texte généré du PV n’est plus disponible');
      }
      const draft = parseMinutesOutput(job.resultText);
      const ctx = await deps.context(note.externalId.slice(EXTERNAL_PREFIX.length));
      const values = minutesTemplateValues(draft, {
        title: ctx.title,
        startedAt: ctx.startedAt,
        durationMs: ctx.durationMs,
        attendees: ctx.attendees,
        agentName: await deps.agentName(data.data.agentId),
        timezone: await deps.timezone(),
      });
      const result = await deps.render({ templateId, values, jobId: job.id });
      return { fileIds: result.fileIds };
    },
  };
}

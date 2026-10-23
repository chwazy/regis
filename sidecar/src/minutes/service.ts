import type { Item, Job } from '@regis/shared';
import type { StartJobInput } from '../jobs/runner';
import { buildMinutesPrompt, DEFAULT_MAX_TRANSCRIPT_CHARS, type MinutesContext } from './prompt';
import { renderMinutes } from './render';
import { MinutesFormatError, parseMinutesOutput, type MinutesDraft } from './schema';

export class MinutesJobError extends Error {}

export interface MinutesSaveInput {
  transcriptItemId: string;
  title: string;
  bodyText: string;
  jobId: string;
  agentId: string;
}

export interface MinutesDeps {
  store: {
    context(transcriptItemId: string): Promise<MinutesContext>;
    save(input: MinutesSaveInput): Promise<Item>;
  };
  runner: { start(input: StartJobInput): Promise<Job>; waitForEnd(jobId: string): Promise<Job> };
  pickAgent(
    task: string,
    entityIds: string[],
  ): Promise<{ agentId: string; agentName: string; reason: string }>;
  timezone(): Promise<string>;
  now?: () => Date;
  /** Réglage `minutes.maxTranscriptChars` ; défaut 60 000. */
  maxTranscriptChars?: () => Promise<number>;
  /** Marque le job en erreur quand sa sortie est inutilisable. */
  failJob?: (jobId: string, error: string) => Promise<void>;
}

const MAX_ATTEMPTS = 2;

export function minutesTitle(transcriptTitle: string): string {
  return `PV — ${transcriptTitle}`;
}

export async function generateMinutes(transcriptItemId: string, deps: MinutesDeps): Promise<Item> {
  const ctx = await deps.store.context(transcriptItemId);
  const maxTranscriptChars = (await deps.maxTranscriptChars?.()) ?? DEFAULT_MAX_TRANSCRIPT_CHARS;
  const firstPrompt = buildMinutesPrompt(ctx, { maxTranscriptChars });
  const agent = await deps.pickAgent(
    `Rédiger le procès-verbal de la réunion « ${ctx.title} »`,
    ctx.entityIds,
  );
  const contextRefs = ctx.entityIds.map((id) => ({ type: 'entity', id }));

  let retryReason: string | undefined;
  let lastError: MinutesFormatError | undefined;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const prompt =
      retryReason === undefined ? firstPrompt : buildMinutesPrompt(ctx, { maxTranscriptChars, retryReason });
    const started = await deps.runner.start({
      agentId: agent.agentId,
      title: minutesTitle(ctx.title),
      prompt,
      routingReason: agent.reason,
      contextRefs,
    });
    const job = await deps.runner.waitForEnd(started.id);
    if (job.status !== 'done' || job.resultText === null) {
      throw new MinutesJobError(job.error ?? `Le job du PV ${job.id} s’est terminé en ${job.status}`);
    }
    let draft: MinutesDraft;
    try {
      draft = parseMinutesOutput(job.resultText);
    } catch (error) {
      if (!(error instanceof MinutesFormatError)) {
        throw error;
      }
      await deps.failJob?.(job.id, error.message);
      lastError = error;
      retryReason = error.message;
      continue;
    }
    const bodyText = renderMinutes(draft, {
      title: ctx.title,
      startedAt: ctx.startedAt,
      durationMs: ctx.durationMs,
      attendees: ctx.attendees,
      agentName: agent.agentName,
      timezone: await deps.timezone(),
    });
    return deps.store.save({
      transcriptItemId,
      title: minutesTitle(ctx.title),
      bodyText,
      jobId: job.id,
      agentId: agent.agentId,
    });
  }
  throw lastError ?? new MinutesFormatError('Sortie du PV invalide');
}

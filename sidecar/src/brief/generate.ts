import { z } from 'zod';
import type { Approval, Brief, BriefData, BriefSections, Item, Job } from '@regis/shared';
import type { StartJobInput } from '../jobs/runner';
import { NoEligibleAgentError } from '../routing/engine';
import type { DecideRoute } from '../routing/service';
import { MessageData } from '../sync/item-schema';

export type BriefLLMOutput = BriefSections & { headline: string };

export class BriefFormatError extends Error {}

export const MAX_PROMPT_MAILS = 30;
export const MAIL_PREVIEW_LENGTH = 200;
const BRIEF_JOB_TIMEOUT_MS = 600_000;
const MAX_ATTEMPTS = 2;

const OutputSchema = z.object({
  headline: z.string().trim().min(1),
  priorities: z.array(
    z.object({
      text: z.string().trim().min(1),
      ref: z.object({ type: z.string().min(1), id: z.string().min(1) }).optional(),
    }),
  ),
  quickActions: z.array(z.string().trim().min(1)).default([]),
});

export function validateBriefOutput(raw: unknown): BriefLLMOutput {
  const parsed = OutputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new BriefFormatError(`Sortie du brief invalide : ${parsed.error.message}`);
  }
  return parsed.data;
}

export function parseBriefText(text: string | null): BriefLLMOutput {
  if (text === null || text.trim() === '') {
    throw new BriefFormatError('Sortie du brief vide');
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) {
    throw new BriefFormatError('Sortie du brief sans objet JSON');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch (error) {
    throw new BriefFormatError(
      `Sortie du brief illisible : ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return validateBriefOutput(raw);
}

export function fallbackHeadline(data: BriefData): string {
  return `${String(data.unreadMails.length)} mails importants, ${String(data.todayEvents.length)} événements, ${String(data.pendingApprovals.length)} validations en attente`;
}

function previewOf(mail: Item): {
  id: string;
  from: string;
  subject: string;
  receivedAt: string | null;
  preview: string;
} {
  const data = MessageData.safeParse(mail.dataJson);
  const sender = data.success ? (data.data.from?.name ?? data.data.from?.address ?? '') : '';
  return {
    id: mail.id,
    from: sender,
    subject: mail.title,
    receivedAt: mail.occurredAt,
    preview: (mail.bodyText ?? '').replace(/\s+/g, ' ').trim().slice(0, MAIL_PREVIEW_LENGTH),
  };
}

export function buildBriefPrompt(data: BriefData, retryReason?: string): string {
  const context = {
    date: data.date,
    unreadMails: data.unreadMails.slice(0, MAX_PROMPT_MAILS).map(previewOf),
    todayEvents: data.todayEvents.map((event) => ({
      id: event.id,
      title: event.title,
      start: event.occurredAt,
    })),
    weekHours: data.weekHours,
    weekTotal: data.weekTotal,
    weekTarget: data.weekTarget,
    overdueInvoices: data.overdueInvoices.map((invoice) => ({ id: invoice.id, title: invoice.title })),
    pendingApprovals: data.pendingApprovals.map((approval: Approval) => ({
      id: approval.id,
      tool: approval.tool,
    })),
    activeJobs: data.activeJobs.map((job: Job) => ({ id: job.id, title: job.title, status: job.status })),
  };
  return [
    'You write the daily brief of a personal command regis. Answer in French.',
    'Use ONLY the data below. Never write a number, an amount, an hour count or a name that is not in the data. Never invent a mail, an event or an invoice.',
    'Reply with a single JSON object and nothing else, with exactly this shape:',
    '{"headline": string (one short sentence), "priorities": [{"text": string, "ref"?: {"type": "item" | "approval" | "job", "id": string}}], "quickActions": [string]}',
    'Priorities are actionable and ordered by urgency; "ref" must use an id present in the data. Quick actions are short labels (3 to 4 words).',
    ...(retryReason
      ? [`Your previous answer was rejected (${retryReason}). Reply with valid JSON only.`]
      : []),
    'Data:',
    JSON.stringify(context),
  ].join('\n');
}

export interface SaveBriefInput {
  date: string;
  jobId: string | null;
  headline: string;
  sectionsJson: BriefSections;
}

export interface BriefGeneratorDeps {
  collect: (now: Date) => Promise<BriefData>;
  getBrief: (date: string) => Promise<Brief | null>;
  saveBrief: (input: SaveBriefInput) => Promise<Brief>;
  route: DecideRoute;
  runner: {
    start: (input: StartJobInput) => Promise<Job>;
    waitForEnd: (jobId: string, timeoutMs?: number) => Promise<Job>;
  };
  failJob: (jobId: string, error: string) => Promise<void>;
  onLog: (line: string) => void;
}

const EMPTY_SECTIONS: BriefSections = { priorities: [], quickActions: [] };

export function createBriefGenerator(
  deps: BriefGeneratorDeps,
): (now: Date, opts?: { force?: boolean }) => Promise<Brief> {
  let current: Promise<Brief> | undefined;

  const attempt = async (
    data: BriefData,
    retryReason: string | undefined,
  ): Promise<{ job: Job; output?: BriefLLMOutput; error?: string }> => {
    const prompt = buildBriefPrompt(data, retryReason);
    const decision = await deps.route({ task: prompt, taskType: 'summary', source: 'brief' });
    const started = await deps.runner.start({
      agentId: decision.agentId,
      title: `Brief du ${data.date}`,
      prompt,
      kind: 'brief',
      routingReason: decision.reason,
    });
    const job = await deps.runner.waitForEnd(started.id, BRIEF_JOB_TIMEOUT_MS);
    if (job.status !== 'done') {
      return { job, error: job.error ?? `Le job du brief s’est terminé en ${job.status}` };
    }
    try {
      return { job, output: parseBriefText(job.resultText) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await deps.failJob(job.id, message);
      return { job, error: message };
    }
  };

  const synthesize = async (data: BriefData): Promise<SaveBriefInput> => {
    let lastJobId: string | null = null;
    let reason: string | undefined;
    for (let index = 0; index < MAX_ATTEMPTS; index += 1) {
      let result: Awaited<ReturnType<typeof attempt>>;
      try {
        result = await attempt(data, reason);
      } catch (error) {
        if (error instanceof NoEligibleAgentError) {
          deps.onLog(`[brief] pas d’agent pour la synthèse : ${error.message}`);
          break;
        }
        throw error;
      }
      lastJobId = result.job.id;
      if (result.output) {
        const { headline, ...sections } = result.output;
        return { date: data.date, jobId: result.job.id, headline, sectionsJson: sections };
      }
      deps.onLog(`[brief] synthèse invalide (essai ${String(index + 1)}) : ${result.error ?? ''}`);
      if (result.job.status !== 'done') {
        break;
      }
      reason = result.error;
    }
    return {
      date: data.date,
      jobId: lastJobId,
      headline: fallbackHeadline(data),
      sectionsJson: EMPTY_SECTIONS,
    };
  };

  const run = async (now: Date, force: boolean): Promise<Brief> => {
    const data = await deps.collect(now);
    if (!force) {
      const existing = await deps.getBrief(data.date);
      if (existing) {
        return existing;
      }
    }
    return deps.saveBrief(await synthesize(data));
  };

  return async (now, opts = {}) => {
    const force = opts.force === true;
    if (current) {
      return current;
    }
    const promise = run(now, force).finally(() => {
      current = undefined;
    });
    current = promise;
    return promise;
  };
}

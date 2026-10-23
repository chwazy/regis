import { describe, expect, it } from 'vitest';
import type { Brief, BriefData, Job } from '@regis/shared';
import { NoEligibleAgentError } from '../routing/engine';
import {
  BriefFormatError,
  buildBriefPrompt,
  createBriefGenerator,
  fallbackHeadline,
  validateBriefOutput,
  MAX_PROMPT_MAILS,
  type SaveBriefInput,
} from './generate';
import { makeApproval, makeEvent, makeMail } from './test-support';

const NOW = new Date('2026-10-22T08:00:00.000Z');
const VALID = JSON.stringify({
  headline: 'Journée calme',
  priorities: [{ text: 'Répondre à Alice', ref: { type: 'item', id: 'm1' } }],
  quickActions: ['Voir les mails'],
});

function makeData(overrides: Partial<BriefData> = {}): BriefData {
  return {
    date: '2026-10-22',
    unreadMails: [makeMail(), makeMail()],
    todayEvents: [makeEvent('2026-10-22T09:00:00.000Z', '2026-10-22T10:00:00.000Z')],
    weekHours: [],
    weekTotal: 0,
    weekTarget: 40,
    overdueInvoices: [],
    pendingApprovals: [makeApproval('a1')],
    activeJobs: [],
    hourSuggestions: [],
    ...overrides,
  };
}

function makeJob(id: string, overrides: Partial<Job> = {}): Job {
  return {
    id,
    parentId: null,
    agentId: 'a1',
    kind: 'brief',
    title: 'Brief',
    prompt: '',
    status: 'done',
    sessionId: null,
    cwd: null,
    costUsd: 0,
    tokensIn: 0,
    tokensOut: 0,
    routingReason: null,
    resultText: null,
    error: null,
    createdAt: '2026-10-22T08:00:00.000Z',
    startedAt: null,
    endedAt: null,
    ...overrides,
  };
}

function setup(results: Partial<Job>[], options: { noAgent?: boolean; data?: BriefData } = {}) {
  const briefs = new Map<string, Brief>();
  const started: { prompt: string; taskType?: string }[] = [];
  const failed: { jobId: string; error: string }[] = [];
  const routed: { taskType?: string; source?: string }[] = [];
  let jobCount = 0;
  const generate = createBriefGenerator({
    collect: () => Promise.resolve(options.data ?? makeData()),
    getBrief: (date) => Promise.resolve(briefs.get(date) ?? null),
    saveBrief: (input: SaveBriefInput) => {
      const saved: Brief = {
        id: briefs.get(input.date)?.id ?? `b${String(briefs.size + 1)}`,
        date: input.date,
        generatedAt: new Date().toISOString(),
        jobId: input.jobId,
        headline: input.headline,
        sectionsJson: input.sectionsJson,
      };
      briefs.set(input.date, saved);
      return Promise.resolve(saved);
    },
    route: (request) => {
      routed.push(request);
      return options.noAgent
        ? Promise.reject(new NoEligibleAgentError('Aucun agent disponible'))
        : Promise.resolve({ agentId: 'a1', reason: 'test', ruleId: null, viaFallback: false });
    },
    runner: {
      start: (input) => {
        jobCount += 1;
        started.push({ prompt: input.prompt });
        return Promise.resolve(makeJob(`j${String(jobCount)}`, { status: 'queued' }));
      },
      waitForEnd: (jobId) => {
        const index = Number(jobId.slice(1)) - 1;
        return Promise.resolve(makeJob(jobId, results[index] ?? results.at(-1) ?? {}));
      },
    },
    failJob: (jobId, error) => {
      failed.push({ jobId, error });
      return Promise.resolve();
    },
    onLog: () => undefined,
  });
  return { generate, briefs, started, failed, routed };
}

describe('validateBriefOutput', () => {
  it('accepts a conforming object', () => {
    const output = validateBriefOutput(JSON.parse(VALID));

    expect(output.headline).toBe('Journée calme');
    expect(output.priorities).toHaveLength(1);
  });

  it('rejects a missing headline', () => {
    expect(() => validateBriefOutput({ priorities: [], quickActions: [] })).toThrow(BriefFormatError);
  });

  it('rejects priorities that are not an array', () => {
    expect(() => validateBriefOutput({ headline: 'x', priorities: 'oops', quickActions: [] })).toThrow(
      BriefFormatError,
    );
  });
});

describe('buildBriefPrompt', () => {
  it('sends only the metadata of the 30 most recent unread mails with a 200 character preview', () => {
    const mails = Array.from({ length: 40 }, (_, index) =>
      makeMail({ title: `Sujet ${String(index)}`, bodyText: 'x'.repeat(500) }),
    );

    const prompt = buildBriefPrompt(makeData({ unreadMails: mails }));
    const context = JSON.parse(prompt.slice(prompt.indexOf('Data:\n') + 'Data:\n'.length)) as {
      unreadMails: { preview: string }[];
    };

    expect(context.unreadMails).toHaveLength(MAX_PROMPT_MAILS);
    expect(context.unreadMails[0]?.preview).toHaveLength(200);
  });
});

describe('generateBrief', () => {
  it('stores the validated synthesis and routes it as a summary', async () => {
    const { generate, briefs, routed } = setup([{ resultText: VALID }]);

    const brief = await generate(NOW);

    expect(brief.headline).toBe('Journée calme');
    expect(brief.jobId).toBe('j1');
    expect(brief.sectionsJson).toEqual({
      priorities: [{ text: 'Répondre à Alice', ref: { type: 'item', id: 'm1' } }],
      quickActions: ['Voir les mails'],
    });
    expect(briefs.size).toBe(1);
    expect(routed[0]).toMatchObject({ taskType: 'summary', source: 'brief' });
  });

  it('accepts JSON wrapped in a code fence', async () => {
    const { generate } = setup([{ resultText: `\`\`\`json\n${VALID}\n\`\`\`` }]);

    expect((await generate(NOW)).headline).toBe('Journée calme');
  });

  it('retries once and keeps the second answer when the first is invalid', async () => {
    const { generate, started, failed } = setup([{ resultText: 'pas du json' }, { resultText: VALID }]);

    const brief = await generate(NOW);

    expect(brief.headline).toBe('Journée calme');
    expect(started).toHaveLength(2);
    expect(started[1]?.prompt).toContain('previous answer was rejected');
    expect(failed.map((entry) => entry.jobId)).toEqual(['j1']);
  });

  it('falls back to a deterministic headline and fails the job after two invalid answers', async () => {
    const { generate, failed, started } = setup([
      { resultText: 'nope' },
      { resultText: '{"priorities":[]}' },
    ]);

    const brief = await generate(NOW);

    expect(brief.headline).toBe('2 mails importants, 1 événements, 1 validations en attente');
    expect(brief.headline).toBe(fallbackHeadline(makeData()));
    expect(brief.sectionsJson).toEqual({ priorities: [], quickActions: [] });
    expect(brief.jobId).toBe('j2');
    expect(started).toHaveLength(2);
    expect(failed.map((entry) => entry.jobId)).toEqual(['j1', 'j2']);
    expect(failed[1]?.error).toContain('invalide');
  });

  it('stores the fallback brief without retrying when the agent job fails', async () => {
    const { generate, started } = setup([{ status: 'failed', error: 'Ollama arrêté' }]);

    const brief = await generate(NOW);

    expect(brief.headline).toBe(fallbackHeadline(makeData()));
    expect(started).toHaveLength(1);
  });

  it('stores the fallback brief without a job when no agent is available', async () => {
    const { generate, started } = setup([], { noAgent: true });

    const brief = await generate(NOW);

    expect(brief.jobId).toBeNull();
    expect(brief.headline).toBe(fallbackHeadline(makeData()));
    expect(started).toHaveLength(0);
  });

  it('does not run a second job the same day without force', async () => {
    const { generate, briefs, started } = setup([{ resultText: VALID }]);

    const first = await generate(NOW);
    const second = await generate(NOW);

    expect(second.id).toBe(first.id);
    expect(briefs.size).toBe(1);
    expect(started).toHaveLength(1);
  });

  it('updates the existing row with force', async () => {
    const { generate, briefs, started } = setup([{ resultText: VALID }]);

    const first = await generate(NOW);
    const second = await generate(NOW, { force: true });

    expect(second.id).toBe(first.id);
    expect(briefs.size).toBe(1);
    expect(started).toHaveLength(2);
  });
});

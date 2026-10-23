import { describe, expect, it, vi } from 'vitest';
import type { Item, Job } from '@regis/shared';
import type { StartJobInput } from '../jobs/runner';
import type { MinutesContext } from './prompt';
import { renderMinutes } from './render';
import { MinutesFormatError } from './schema';
import { generateMinutes, type MinutesDeps } from './service';

const ctx: MinutesContext = {
  transcriptItemId: 'T1',
  title: 'Point client',
  transcript: 'Bonjour à tous.',
  startedAt: '2026-10-22T08:00:00Z',
  durationMs: 600_000,
  attendees: [{ name: 'Alice', address: 'alice@example.com' }],
  entityIds: ['E-local'],
};

const draft = { summary: 'Résumé.', decisions: [], actions: [], openPoints: [] };
const validOutput = JSON.stringify(draft);

function setup(outputs: string[], agentId = 'A-ollama') {
  const queue = [...outputs];
  const jobs = new Map<string, Job>();
  const started: StartJobInput[] = [];
  const save = vi.fn((input: { bodyText: string }) =>
    Promise.resolve({ id: 'PV1', bodyText: input.bodyText } as Item),
  );
  const pickAgent = vi.fn(() => Promise.resolve({ agentId, agentName: 'Ollama local', reason: 'local' }));
  const deps: MinutesDeps = {
    store: { context: () => Promise.resolve(ctx), save },
    runner: {
      start: (input) => {
        started.push(input);
        const job = {
          id: `J${String(started.length)}`,
          status: 'done',
          resultText: queue.shift() ?? null,
          error: null,
        } as Job;
        jobs.set(job.id, job);
        return Promise.resolve(job);
      },
      waitForEnd: (id) => Promise.resolve(jobs.get(id) as Job),
    },
    pickAgent,
    timezone: () => Promise.resolve('Europe/Zurich'),
  };
  return { deps, save, started, pickAgent };
}

describe('generateMinutes', () => {
  it('saves the rendered Markdown once for a valid output', async () => {
    const { deps, save, started } = setup([validOutput]);
    await generateMinutes('T1', deps);
    expect(started).toHaveLength(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[0].bodyText).toBe(
      renderMinutes(draft, {
        title: ctx.title,
        startedAt: ctx.startedAt,
        durationMs: ctx.durationMs,
        attendees: ctx.attendees,
        agentName: 'Ollama local',
        timezone: 'Europe/Zurich',
      }),
    );
  });

  it('retries once after an invalid output', async () => {
    const { deps, save, started } = setup(['pas du json', validOutput]);
    await generateMinutes('T1', deps);
    expect(started).toHaveLength(2);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('fails explicitly after two invalid outputs, without saving', async () => {
    const { deps, save, started } = setup(['non', 'toujours non']);
    await expect(generateMinutes('T1', deps)).rejects.toBeInstanceOf(MinutesFormatError);
    expect(started).toHaveLength(2);
    expect(save).not.toHaveBeenCalled();
  });

  it('routes with the entity ids and runs the job on the agent chosen by the routing', async () => {
    const { deps, pickAgent, started } = setup([validOutput], 'A-ollama');
    await generateMinutes('T1', deps);
    expect(pickAgent).toHaveBeenCalledWith(expect.any(String), ['E-local']);
    expect(started[0]?.agentId).toBe('A-ollama');
  });
});

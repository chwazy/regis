import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { NewJob } from '@regis/shared';
import type { AgentDriver, AgentRunInput } from '../agents/driver';
import { makeAgent } from '../agents/test-support';
import { JobNotFoundError, JobNotResumableError } from './runner';
import { createTestRunner, waitUntil, type TestRunner } from './test-support';

const SIMPLE_COST = 0.00028688;
const created: TestRunner[] = [];

function setup(options: Parameters<typeof createTestRunner>[0] = {}): TestRunner {
  const testRunner = createTestRunner(options);
  created.push(testRunner);
  return testRunner;
}

function newJob(status: NewJob['status']): NewJob {
  return {
    parentId: null,
    agentId: 'a1',
    kind: 'task',
    title: 'Old',
    prompt: 'x',
    status,
    sessionId: null,
    cwd: null,
    routingReason: null,
    resultText: null,
    error: null,
    startedAt: null,
    endedAt: null,
  };
}

describe('JobRunner', () => {
  afterEach(() => {
    for (const testRunner of created.splice(0)) {
      testRunner.cleanup();
    }
  });

  it('takes a job through queued, running and done with cost, tokens and events', async () => {
    const { runner, store } = setup();

    const job = await runner.start({ agentId: 'a1', title: 'Ping', prompt: 'ping' });
    expect(job.status).toBe('queued');
    const finished = await runner.waitForEnd(job.id);

    expect(store.statusHistory.get(job.id)).toEqual(['queued', 'running', 'done']);
    expect(finished.costUsd).toBe(SIMPLE_COST);
    expect(finished.tokensIn).toBeGreaterThan(0);
    expect(finished.sessionId).toBeTruthy();
    expect(finished.resultText).toBe('pong');
    expect(finished.endedAt).not.toBeNull();
    const types = store.events.filter((event) => event.jobId === job.id).map((event) => event.type);
    expect(types[0]).toBe('start');
    expect(types.at(-1)).toBe('end');
    expect(store.events[0]?.payloadJson).toMatchObject({ resumed: false, worktree: null, contextRefs: [] });
  });

  it('keeps the second of two simultaneous jobs queued while maxConcurrent is 1', async () => {
    const { runner, store } = setup({
      settings: { 'jobs.maxConcurrent': '1' },
      fakeEnv: { FAKE_CLAUDE_DELAY_MS: '150' },
    });

    const first = await runner.start({ agentId: 'a1', title: 'One', prompt: 'one' });
    const second = await runner.start({ agentId: 'a1', title: 'Two', prompt: 'two' });
    await waitUntil(() => store.jobs.get(first.id)?.status === 'running');

    expect(store.jobs.get(second.id)?.status).toBe('queued');
    await runner.waitForEnd(second.id);
    expect(store.jobs.get(first.id)?.status).toBe('done');
    expect(store.jobs.get(second.id)?.status).toBe('done');
    const firstEnd = store.jobs.get(first.id)?.endedAt ?? '';
    const secondStart = store.jobs.get(second.id)?.startedAt ?? '';
    expect(secondStart >= firstEnd).toBe(true);
  });

  it('cancels a running job and kills the process in under 2 seconds', async () => {
    const { runner, store } = setup({ fixture: 'tool-use', fakeEnv: { FAKE_CLAUDE_DELAY_MS: '10000' } });
    const job = await runner.start({ agentId: 'a1', title: 'Long', prompt: 'long' });
    await waitUntil(() => store.events.some((event) => event.jobId === job.id && event.type === 'start'));

    const startedAt = Date.now();
    await runner.cancel(job.id);

    expect(Date.now() - startedAt).toBeLessThan(2000);
    const cancelled = store.jobs.get(job.id);
    expect(cancelled?.status).toBe('cancelled');
    expect(cancelled?.endedAt).not.toBeNull();
  });

  it('cancels a queued job without running it and cancels running children with the parent', async () => {
    const { runner, store } = setup({
      settings: { 'jobs.maxConcurrent': '2' },
      fakeEnv: { FAKE_CLAUDE_DELAY_MS: '10000' },
    });
    const parent = await runner.start({ agentId: 'a1', title: 'Parent', prompt: 'p' });
    const child = await runner.start({ agentId: 'a1', title: 'Child', prompt: 'c', parentId: parent.id });
    const queued = await runner.start({ agentId: 'a1', title: 'Queued', prompt: 'q' });
    await waitUntil(() => store.jobs.get(child.id)?.status === 'running');
    await waitUntil(() => store.jobs.get(parent.id)?.status === 'running');

    await runner.cancel(queued.id);
    await runner.cancel(parent.id);

    expect(store.jobs.get(queued.id)?.status).toBe('cancelled');
    expect(store.events.some((event) => event.jobId === queued.id && event.type === 'start')).toBe(false);
    expect(store.jobs.get(child.id)?.status).toBe('cancelled');
    expect(store.jobs.get(parent.id)?.status).toBe('cancelled');
  });

  it('keeps the parent suspended until its last parallel child ends', async () => {
    const { runner, store } = setup({
      settings: { 'jobs.maxConcurrent': '2' },
      fakeEnv: { FAKE_CLAUDE_DELAY_MS: '10000' },
    });
    const parent = await runner.start({ agentId: 'a1', title: 'Parent', prompt: 'p' });
    await waitUntil(() => store.jobs.get(parent.id)?.status === 'running');
    const first = await runner.start({ agentId: 'a1', title: 'First', prompt: 'c1', parentId: parent.id });
    const second = await runner.start({ agentId: 'a1', title: 'Second', prompt: 'c2', parentId: parent.id });
    const firstEnd = runner.waitForChildEnd(parent.id, first.id);
    const secondEnd = runner.waitForChildEnd(parent.id, second.id);
    await waitUntil(() => store.jobs.get(first.id)?.status === 'running');
    await waitUntil(() => store.jobs.get(second.id)?.status === 'running');

    await runner.cancel(first.id);
    await firstEnd;
    const other = await runner.start({ agentId: 'a1', title: 'Other', prompt: 'o' });
    await waitUntil(() => store.jobs.get(other.id)?.status === 'running');

    await runner.cancel(second.id);
    await secondEnd;
    await runner.cancel(other.id);
    await runner.cancel(parent.id);
  });

  it('refuses to resume a job without a session', async () => {
    const { runner, store } = setup({ fixture: 'simple', fakeEnv: { FAKE_CLAUDE_EXIT: '0' } });
    const job = await store.createJob(newJob('done'));

    await expect(runner.resume(job.id, 'again')).rejects.toBeInstanceOf(JobNotResumableError);
    await expect(runner.resume('nope', 'again')).rejects.toBeInstanceOf(JobNotFoundError);
  });

  it('refuses to resume when the runtime cannot resume sessions', async () => {
    const { runner, store } = setup({
      agents: [makeAgent(), makeAgent({ id: 'api', runtime: 'anthropic-api' })],
    });
    const job = await store.createJob({ ...newJob('done'), agentId: 'api', sessionId: 's1' });

    await expect(runner.resume(job.id, 'again')).rejects.toBeInstanceOf(JobNotResumableError);
  });

  it('replays the conversation to a runtime without sessions when resuming', async () => {
    const inputs: AgentRunInput[] = [];
    const historyDriver: AgentDriver = {
      runtime: 'ollama',
      supportsHistory: true,
      run: async function* (input) {
        await Promise.resolve();
        inputs.push(input);
        yield { type: 'message', text: `réponse ${inputs.length}` };
        yield { type: 'end', resultText: `réponse ${inputs.length}`, isError: false };
      },
      test: () => Promise.resolve({ ok: true, latencyMs: 0, costUsd: 0 }),
    };
    const { runner } = setup({
      agents: [makeAgent({ id: 'local', runtime: 'ollama' })],
      drivers: { ollama: historyDriver },
    });
    const job = await runner.start({ agentId: 'local', title: 'Chat', prompt: 'Test test', kind: 'chat' });
    await runner.waitForEnd(job.id);

    await runner.resume(job.id, 'Quel modèle ?');
    const second = await runner.waitForEnd(job.id);

    expect(second.status).toBe('done');
    expect(inputs[0]?.history).toBeUndefined();
    expect(inputs[1]?.prompt).toBe('Quel modèle ?');
    expect(inputs[1]?.history).toEqual([
      { role: 'user', text: 'Test test' },
      { role: 'assistant', text: 'réponse 1' },
    ]);
  });

  it('resumes the same session with a new message and accumulates the cost', async () => {
    const { runner, store } = setup();
    const job = await runner.start({ agentId: 'a1', title: 'Chat', prompt: 'hi', kind: 'chat' });
    const first = await runner.waitForEnd(job.id);

    const resumed = await runner.resume(job.id, 'and now?');
    expect(resumed.status).toBe('queued');
    const second = await runner.waitForEnd(job.id);

    expect(second.sessionId).toBe(first.sessionId);
    expect(second.costUsd).toBeCloseTo(SIMPLE_COST * 2, 8);
    expect(store.statusHistory.get(job.id)).toEqual([
      'queued',
      'running',
      'done',
      'queued',
      'running',
      'done',
    ]);
    const userMessages = store.events.filter(
      (event) => event.type === 'message' && (event.payloadJson as { role?: string }).role === 'user',
    );
    expect(userMessages.map((event) => event.summary)).toEqual(['and now?']);
  });

  it('queues a message sent while the job is running and replays it afterwards', async () => {
    const { runner, store } = setup({ fakeEnv: { FAKE_CLAUDE_DELAY_MS: '100' } });
    const job = await runner.start({ agentId: 'a1', title: 'Chat', prompt: 'hi', kind: 'chat' });
    await waitUntil(() => store.jobs.get(job.id)?.status === 'running');

    await runner.resume(job.id, 'one more thing');
    await runner.waitForEnd(job.id);

    expect(store.statusHistory.get(job.id)).toEqual([
      'queued',
      'running',
      'done',
      'queued',
      'running',
      'done',
    ]);
  });

  it('marks the job failed when the agent stream ends without a result', async () => {
    const { runner } = setup({
      fakeEnv: { FAKE_CLAUDE_FIXTURE: join(tmpdir(), 'regis-missing-fixture.ndjson') },
    });
    const job = await runner.start({ agentId: 'a1', title: 'Broken', prompt: 'x' });

    const finished = await runner.waitForEnd(job.id);

    expect(finished.status).toBe('failed');
    expect(finished.error).toBeTruthy();
  });

  it('keeps waiting_approval after the agent ends and moves back to running on resume', async () => {
    const { runner, store } = setup({ fakeEnv: { FAKE_CLAUDE_DELAY_MS: '100' } });
    const job = await runner.start({ agentId: 'a1', title: 'Needs approval', prompt: 'x' });
    await waitUntil(() => store.jobs.get(job.id)?.status === 'running');
    await store.updateJob(job.id, { status: 'waiting_approval' });

    const afterRun = await runner.waitForEnd(job.id);
    expect(afterRun.status).toBe('waiting_approval');
    await runner.resumeAfterApproval(job.id, 'validated');
    const resumed = await runner.waitForEnd(job.id);

    expect(resumed.status).toBe('done');
    expect(store.statusHistory.get(job.id)).toEqual([
      'queued',
      'running',
      'waiting_approval',
      'queued',
      'running',
      'done',
    ]);
  });

  it('marks jobs left running or queued by a previous run as interrupted', async () => {
    const { runner, store } = setup();
    const running = await store.createJob(newJob('running'));
    const waiting = await store.createJob(newJob('waiting_approval'));

    const recovered = await runner.recoverInterrupted();

    expect(recovered).toBe(1);
    expect(store.jobs.get(running.id)).toMatchObject({ status: 'failed', error: 'interrupted' });
    expect(store.jobs.get(running.id)?.endedAt).not.toBeNull();
    expect(store.jobs.get(waiting.id)?.status).toBe('waiting_approval');
  });
});

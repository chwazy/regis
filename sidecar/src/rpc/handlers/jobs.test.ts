import { describe, expect, it } from 'vitest';
import { RpcErrorCode, type Job } from '@regis/shared';
import { JobNotFoundError, JobNotResumableError } from '../../jobs/runner';
import { ChatError } from '../../orchestrator/chat';
import { RpcMethodError } from '../server';
import { createJobsMethods, type JobsHandlerDeps } from './jobs';

const JOB = { id: 'j1', cwd: null } as Job;

function methods(overrides: Partial<JobsHandlerDeps> = {}) {
  const calls: unknown[][] = [];
  const handlers = createJobsMethods({
    runner: {
      start: (input) => {
        calls.push(['start', input]);
        return Promise.resolve(JOB);
      },
      cancel: (jobId) => {
        calls.push(['cancel', jobId]);
        return Promise.resolve();
      },
      resume: (jobId, message) => {
        calls.push(['resume', jobId, message]);
        return Promise.resolve(JOB);
      },
    },
    chat: {
      send: (params) => {
        calls.push(['chat', params]);
        return Promise.resolve(JOB);
      },
    },
    getJob: () => Promise.resolve(JOB),
    getDataDir: () => Promise.resolve('data'),
    route: () => Promise.resolve({ agentId: 'routed', ruleId: null, reason: 'because', viaFallback: true }),
    ...overrides,
  });
  return { handlers, calls };
}

describe('jobs RPC methods', () => {
  it('routes start, cancel, resume and chat.send to the runner and the chat', async () => {
    const { handlers, calls } = methods();

    await handlers['jobs.start']?.({ agentId: 'a1', title: 'T', prompt: 'p' });
    await expect(handlers['jobs.cancel']?.({ jobId: 'j1' })).resolves.toEqual({});
    await handlers['jobs.resume']?.({ jobId: 'j1', message: 'again' });
    await handlers['chat.send']?.({ text: 'hello' });
    await handlers['chat.send']?.({ chatJobId: 'c1', text: 'more' });

    expect(calls).toEqual([
      ['start', { agentId: 'a1', title: 'T', prompt: 'p' }],
      ['cancel', 'j1'],
      ['resume', 'j1', 'again'],
      ['chat', { text: 'hello' }],
      ['chat', { chatJobId: 'c1', text: 'more' }],
    ]);
  });

  it('routes the job when agentId is omitted and records the reason', async () => {
    const { handlers, calls } = methods();

    await handlers['jobs.start']?.({ title: 'T', prompt: 'p', taskType: 'code' });

    expect(calls).toEqual([
      ['start', { title: 'T', prompt: 'p', agentId: 'routed', routingReason: 'because' }],
    ]);
  });

  it('rejects invalid params and maps domain errors to InvalidParams', async () => {
    const { handlers } = methods({
      runner: {
        start: () => Promise.reject(new JobNotFoundError('x')),
        cancel: () => Promise.reject(new JobNotFoundError('x')),
        resume: () => Promise.reject(new JobNotResumableError('pas de session')),
      },
      chat: { send: () => Promise.reject(new ChatError('vide')) },
    });

    const failures = await Promise.all(
      [
        handlers['jobs.start']?.({ title: 'missing agent' }),
        handlers['jobs.cancel']?.({ jobId: 'j1' }),
        handlers['jobs.resume']?.({ jobId: 'j1', message: 'm' }),
        handlers['chat.send']?.({ text: 'x' }),
      ].map((call) =>
        Promise.resolve(call).then(
          () => undefined,
          (error: unknown) => error,
        ),
      ),
    );

    for (const failure of failures) {
      expect(failure).toBeInstanceOf(RpcMethodError);
      expect((failure as RpcMethodError).code).toBe(RpcErrorCode.InvalidParams);
    }
  });

  it('only cleans the worktree folder that belongs to the job', async () => {
    const { handlers } = methods();

    await expect(handlers['jobs.cleanup']?.({ jobId: 'j1' })).resolves.toMatchObject({ removed: false });
  });
});

describe('terminal RPC methods', () => {
  it('opens and ends a terminal session through the pty service', async () => {
    const calls: unknown[][] = [];
    const { handlers } = methods({
      pty: {
        open: (jobId, resume, size) => {
          calls.push(['open', jobId, resume, size]);
          return Promise.resolve();
        },
        end: (jobId, outcome) => {
          calls.push(['end', jobId, outcome]);
          return Promise.resolve();
        },
      },
    });

    await expect(
      handlers['jobs.openPty']?.({ jobId: 'j1', resume: true, cols: 90, rows: 25 }),
    ).resolves.toEqual({});
    await handlers['jobs.endPty']?.({ jobId: 'j1', code: 0, requested: true });

    expect(calls).toEqual([
      ['open', 'j1', true, { cols: 90, rows: 25 }],
      ['end', 'j1', { code: 0, requested: true }],
    ]);
  });

  it('reports a non resumable job as invalid params and a missing service as not configured', async () => {
    const { handlers } = methods({
      pty: {
        open: () => Promise.reject(new JobNotResumableError('running')),
        end: () => Promise.resolve(),
      },
    });
    const refused = await Promise.resolve(
      handlers['jobs.openPty']?.({ jobId: 'j1', resume: true, cols: 80, rows: 24 }),
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    const unconfigured = await Promise.resolve(
      methods().handlers['jobs.openPty']?.({ jobId: 'j1', cols: 80, rows: 24 }),
    ).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect((refused as RpcMethodError).code).toBe(RpcErrorCode.InvalidParams);
    expect((unconfigured as RpcMethodError).code).toBe(RpcErrorCode.NotConfigured);
  });
});

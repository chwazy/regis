import { afterEach, describe, expect, it } from 'vitest';
import type { Job } from '@regis/shared';
import { createMemoryJobStore, type MemoryJobStore } from '../jobs/test-support';
import { createHookTools, isPermissionRequest } from './hook-tools';
import { RegisMcpServer } from './server';

const servers: RegisMcpServer[] = [];

async function terminalJob(store: MemoryJobStore, status: Job['status'] = 'running'): Promise<Job> {
  return store.createJob({
    parentId: null,
    agentId: 'a1',
    kind: 'task',
    title: 'Terminal',
    prompt: 'go',
    status,
    sessionId: 'session-1',
    cwd: null,
    routingReason: null,
    resultText: null,
    error: null,
    startedAt: null,
    endedAt: null,
  });
}

function hookTools(store: MemoryJobStore, openJobs: string[]) {
  return createHookTools({
    isTerminalJob: (jobId) => openJobs.includes(jobId),
    getJob: store.getJob,
    updateJob: store.updateJob,
    appendEvent: store.appendEvent,
  });
}

describe('job_status_hook', () => {
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.stop()));
  });

  it('Stop moves the job to done', async () => {
    const store = createMemoryJobStore();
    const job = await terminalJob(store);
    const tools = hookTools(store, [job.id]);

    const result = await tools.jobStatusHook({ jobId: job.id, event: 'Stop' });

    expect(result).toEqual({ isError: false, payload: {} });
    expect(store.jobs.get(job.id)).toMatchObject({ status: 'done', error: null });
    expect(store.jobs.get(job.id)?.endedAt).not.toBeNull();
  });

  it('Stop does not resurrect a cancelled job', async () => {
    const store = createMemoryJobStore();
    const job = await terminalJob(store, 'cancelled');

    await hookTools(store, [job.id]).jobStatusHook({ jobId: job.id, event: 'Stop' });

    expect(store.jobs.get(job.id)?.status).toBe('cancelled');
  });

  it('a permission Notification records a message and waits for approval', async () => {
    const store = createMemoryJobStore();
    const job = await terminalJob(store);

    await hookTools(store, [job.id]).jobStatusHook({
      jobId: job.id,
      event: 'Notification',
      message: 'Claude needs your permission',
    });

    expect(store.jobs.get(job.id)?.status).toBe('waiting_approval');
    expect(store.events).toHaveLength(1);
    expect(store.events[0]).toMatchObject({ type: 'message', summary: 'Claude needs your permission' });
  });

  it('another Notification only records a message', async () => {
    const store = createMemoryJobStore();
    const job = await terminalJob(store);

    await hookTools(store, [job.id]).jobStatusHook({
      jobId: job.id,
      event: 'Notification',
      message: 'Claude is waiting for your input',
    });

    expect(store.jobs.get(job.id)?.status).toBe('running');
    expect(store.events).toHaveLength(1);
  });

  it('refuses jobs without an open terminal, unknown events and unknown jobs', async () => {
    const store = createMemoryJobStore();
    const job = await terminalJob(store);

    const closed = await hookTools(store, []).jobStatusHook({ jobId: job.id, event: 'Stop' });
    const invalid = await hookTools(store, [job.id]).jobStatusHook({ jobId: job.id, event: 'Other' });
    const missing = await hookTools(store, ['nope']).jobStatusHook({ jobId: 'nope', event: 'Stop' });

    expect(closed.isError).toBe(true);
    expect(invalid.isError).toBe(true);
    expect(missing.isError).toBe(true);
    expect(store.jobs.get(job.id)?.status).toBe('running');
  });

  it('recognises the permission message captured from the real CLI', () => {
    expect(isPermissionRequest('Claude needs your permission')).toBe(true);
    expect(isPermissionRequest('Claude is waiting for your input')).toBe(false);
    expect(isPermissionRequest(undefined)).toBe(false);
  });

  it('is exposed through the regis MCP endpoint and a Stop call finishes the job', async () => {
    const store = createMemoryJobStore();
    const job = await terminalJob(store);
    const server = new RegisMcpServer({
      approve: () => Promise.resolve({ behavior: 'allow' }),
      onLog: () => undefined,
      hooks: hookTools(store, [job.id]),
    });
    servers.push(server);
    const { url, token } = await server.start();
    const call = async (body: unknown) =>
      (await (
        await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(body),
        })
      ).json()) as { result: { tools?: { name: string }[]; isError?: boolean } };

    const listing = await call({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const stop = await call({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'job_status_hook', arguments: { jobId: job.id, event: 'Stop' } },
    });

    expect(listing.result.tools?.map((tool) => tool.name)).toContain('job_status_hook');
    expect(stop.result.isError).toBeUndefined();
    expect(store.jobs.get(job.id)?.status).toBe('done');
  });
});

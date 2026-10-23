import { afterEach, describe, expect, it } from 'vitest';
import { makeAgent } from '../agents/test-support';
import { createTestRunner, waitUntil, type TestRunner } from '../jobs/test-support';
import { createRoutingService } from '../routing/service';
import { createJobsTools, REGIS_JOB_TOOLS, type JobsTools } from './jobs-tools';
import { RegisMcpServer, REGIS_AGENT_HEADER, REGIS_JOB_HEADER } from './server';

const created: TestRunner[] = [];
const servers: RegisMcpServer[] = [];

function setup(
  settings: Record<string, string> = {},
  fakeEnv: Record<string, string> = {},
): { testRunner: TestRunner; tools: JobsTools } {
  const testRunner = createTestRunner({
    settings,
    fakeEnv,
    agents: [
      makeAgent({ id: 'boss', canSpawn: true }),
      makeAgent({ id: 'worker', canSpawn: false }),
      makeAgent({ id: 'off', enabled: false }),
    ],
  });
  created.push(testRunner);
  const tools = createJobsTools({
    runner: {
      start: (input) => testRunner.runner.start(input),
      waitForChildEnd: (parentId, childId, timeoutMs) =>
        testRunner.runner.waitForChildEnd(parentId, childId, timeoutMs),
    },
    getJob: (id) => testRunner.store.getJob(id),
    lastEventSummary: (jobId) =>
      Promise.resolve(testRunner.store.events.filter((event) => event.jobId === jobId).at(-1)?.summary),
    listAgents: () => Promise.resolve([...testRunner.agents.values()]),
    getSetting: (key) => Promise.resolve(settings[key] ?? null),
    route: createRoutingService({
      listEntities: () => Promise.resolve([]),
      listLinks: () => Promise.resolve([]),
      listJobs: () => Promise.resolve([]),
      listAgents: () => Promise.resolve([...testRunner.agents.values()]),
      listRules: () => Promise.resolve([]),
      getSetting: (key) => Promise.resolve(settings[key] ?? null),
      getDriver: () => {
        throw new Error('no driver in tests');
      },
      getDataDir: () => Promise.resolve(testRunner.dataDir),
    }).decide,
  });
  return { testRunner, tools };
}

async function rootJob(testRunner: TestRunner, agentId = 'boss', parentId?: string) {
  const job = await testRunner.runner.start({
    agentId,
    title: 'Root',
    prompt: 'root',
    ...(parentId ? { parentId } : {}),
  });
  await testRunner.runner.waitForEnd(job.id);
  return job;
}

describe('regis job tools', () => {
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.stop()));
    for (const testRunner of created.splice(0)) {
      testRunner.cleanup();
    }
  });

  it('spawn_job with waitForResult creates a child of the caller job and returns its result', async () => {
    const { testRunner, tools } = setup();
    const parent = await rootJob(testRunner);

    const result = await tools.spawnJob(
      { jobId: parent.id, agentId: 'boss' },
      { title: 'Child', prompt: 'do it', agentId: 'worker', waitForResult: true },
    );

    expect(result.isError).toBe(false);
    const payload = result.payload as { jobId: string; status: string; resultText?: string };
    expect(payload.status).toBe('done');
    expect(payload.resultText).toBe('pong');
    expect(testRunner.store.jobs.get(payload.jobId)).toMatchObject({
      parentId: parent.id,
      agentId: 'worker',
      title: 'Child',
    });
  });

  it('lets a running parent wait for its child with maxConcurrent 1', async () => {
    const { testRunner, tools } = setup({ 'jobs.maxConcurrent': '1' }, { FAKE_CLAUDE_DELAY_MS: '300' });
    const parent = await testRunner.runner.start({ agentId: 'boss', title: 'P', prompt: 'p' });
    await waitUntil(() => testRunner.store.jobs.get(parent.id)?.status === 'running');

    const spawned = tools.spawnJob(
      { jobId: parent.id, agentId: 'boss' },
      { title: 'C', prompt: 'c', agentId: 'worker', waitForResult: true },
    );
    await waitUntil(() =>
      [...testRunner.store.jobs.values()].some(
        (job) => job.parentId === parent.id && job.status === 'running',
      ),
    );

    expect(testRunner.store.jobs.get(parent.id)?.status).toBe('running');
    expect((await spawned).payload).toMatchObject({ status: 'done', resultText: 'pong' });
    await testRunner.runner.waitForEnd(parent.id);
    expect(testRunner.store.jobs.get(parent.id)?.status).toBe('done');
  });

  it('admits the children of every waiting parent when all slots are held by parents', async () => {
    const { testRunner, tools } = setup({ 'jobs.maxConcurrent': '2' }, { FAKE_CLAUDE_DELAY_MS: '300' });
    const parents = await Promise.all(
      ['A', 'B'].map((title) => testRunner.runner.start({ agentId: 'boss', title, prompt: 'p' })),
    );
    await waitUntil(() =>
      parents.every((parent) => testRunner.store.jobs.get(parent.id)?.status === 'running'),
    );

    const spawned = parents.map((parent) =>
      tools.spawnJob(
        { jobId: parent.id, agentId: 'boss' },
        { title: 'C', prompt: 'c', agentId: 'worker', waitForResult: true },
      ),
    );
    await waitUntil(
      () =>
        [...testRunner.store.jobs.values()].filter((job) => job.parentId !== null && job.status === 'running')
          .length === 2,
    );

    expect(parents.map((parent) => testRunner.store.jobs.get(parent.id)?.status)).toEqual([
      'running',
      'running',
    ]);
    const results = await Promise.all(spawned);
    expect(results.map((result) => (result.payload as { status: string }).status)).toEqual(['done', 'done']);
    await Promise.all(parents.map((parent) => testRunner.runner.waitForEnd(parent.id)));
  });

  it('spawn_job without waitForResult returns right away with the job id', async () => {
    const { testRunner, tools } = setup();
    const parent = await rootJob(testRunner);

    const result = await tools.spawnJob({ jobId: parent.id, agentId: 'boss' }, { title: 'C', prompt: 'p' });

    expect(result.payload).toMatchObject({ status: 'queued' });
    await testRunner.runner.waitForEnd((result.payload as { jobId: string }).jobId);
  });

  it('uses the configured default agent when agentId is omitted', async () => {
    const { testRunner, tools } = setup({ 'agents.defaultAgentId': 'worker' });
    const parent = await rootJob(testRunner);

    const result = await tools.spawnJob(
      { jobId: parent.id, agentId: 'boss' },
      { title: 'C', prompt: 'p', waitForResult: true },
    );

    const { jobId } = result.payload as { jobId: string };
    expect(testRunner.store.jobs.get(jobId)?.agentId).toBe('worker');
    expect(testRunner.store.jobs.get(jobId)?.routingReason).toContain('agent par défaut');
  });

  it('refuses callers that cannot spawn, unknown targets and disabled targets', async () => {
    const { testRunner, tools } = setup();
    const parent = await rootJob(testRunner);

    const notAllowed = await tools.spawnJob(
      { jobId: parent.id, agentId: 'worker' },
      { title: 'C', prompt: 'p' },
    );
    const unknown = await tools.spawnJob(
      { jobId: parent.id, agentId: 'boss' },
      { title: 'C', prompt: 'p', agentId: 'ghost' },
    );
    const disabled = await tools.spawnJob(
      { jobId: parent.id, agentId: 'boss' },
      { title: 'C', prompt: 'p', agentId: 'off' },
    );
    const invalid = await tools.spawnJob({ jobId: parent.id, agentId: 'boss' }, { title: '' });

    expect([notAllowed, unknown, disabled, invalid].map((result) => result.isError)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect([...testRunner.store.jobs.keys()]).toEqual([parent.id]);
  });

  it('refuses to spawn deeper than jobs.maxDepth', async () => {
    const { testRunner, tools } = setup();
    const root = await rootJob(testRunner);
    const child = await rootJob(testRunner, 'boss', root.id);
    const grandChild = await rootJob(testRunner, 'boss', child.id);

    const fromChild = await tools.spawnJob(
      { jobId: child.id, agentId: 'boss' },
      { title: 'C', prompt: 'p', waitForResult: true },
    );
    const fromGrandChild = await tools.spawnJob(
      { jobId: grandChild.id, agentId: 'boss' },
      { title: 'C', prompt: 'p' },
    );

    expect(fromChild.isError).toBe(false);
    expect(fromGrandChild.isError).toBe(true);
    expect(JSON.stringify(fromGrandChild.payload)).toContain('Profondeur');
  });

  it('honours a custom jobs.maxDepth', async () => {
    const { testRunner, tools } = setup({ 'jobs.maxDepth': '0' });
    const root = await rootJob(testRunner);

    const result = await tools.spawnJob({ jobId: root.id, agentId: 'boss' }, { title: 'C', prompt: 'p' });

    expect(result.isError).toBe(true);
  });

  it('job_status and job_result report the job state', async () => {
    const { testRunner, tools } = setup();
    const job = await rootJob(testRunner, 'worker');
    await testRunner.runner.waitForEnd(job.id);

    const status = await tools.jobStatus({ jobId: job.id });
    const result = await tools.jobResult({ jobId: job.id });
    const missing = await tools.jobResult({ jobId: 'nope' });

    expect(status.payload).toMatchObject({ status: 'done', costUsd: 0.00028688 });
    expect((status.payload as { lastEvent?: string }).lastEvent).toBeTruthy();
    expect(result.payload).toEqual({ status: 'done', resultText: 'pong' });
    expect(missing.isError).toBe(true);
  });

  it('exposes the three tools through the regis MCP endpoint and lists them as allowed for spawners', async () => {
    const { tools } = setup();
    const server = new RegisMcpServer({
      approve: () => Promise.resolve({ behavior: 'allow' }),
      onLog: () => undefined,
      jobs: tools,
    });
    servers.push(server);
    const { url, token } = await server.start();

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
        [REGIS_JOB_HEADER]: 'j1',
        [REGIS_AGENT_HEADER]: 'boss',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    const body = (await response.json()) as { result: { tools: { name: string }[] } };

    expect(body.result.tools.map((tool) => tool.name).sort()).toEqual([
      'approve',
      'job_result',
      'job_status',
      'spawn_job',
    ]);
    expect(REGIS_JOB_TOOLS).toEqual([
      'mcp__regis__spawn_job',
      'mcp__regis__job_status',
      'mcp__regis__job_result',
    ]);
  });
});

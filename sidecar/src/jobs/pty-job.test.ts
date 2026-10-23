import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Connector, Job } from '@regis/shared';
import { createLaunchResolver } from '../connectors/launch';
import { ODOO_DEV_ENTRY, buildFromPreset } from '../connectors/presets';
import { denyWritesPolicy } from '../agents/deny-writes-policy';
import { makeAgent } from '../agents/test-support';
import { REGIS_TOKEN_ENV } from '../agents/claude-cli';
import { PtyJobs, buildPtyArgs, type PtyLaunch } from './pty-job';
import { JobNotResumableError, JobRunner } from './runner';
import { createMemoryJobStore, type MemoryJobStore } from './test-support';

const REGIS_TOKEN = 'regis-token-value';
const dataDirs: string[] = [];

interface Harness {
  store: MemoryJobStore;
  runner: JobRunner;
  pty: PtyJobs;
  closed: string[];
  opened: { jobId: string; launch: PtyLaunch; cols: number; rows: number }[];
}

function setup(openError?: Error, connectors: Connector[] = []): Harness {
  const store = createMemoryJobStore();
  const dataDir = mkdtempSync(join(tmpdir(), 'regis-pty-test-'));
  dataDirs.push(dataDir);
  const agents = [
    makeAgent({
      id: 'term',
      mode: 'pty',
      model: 'haiku',
      connectorIdsJson: connectors.map((connector) => connector.id),
    }),
    makeAgent({ id: 'head', mode: 'headless' }),
    makeAgent({ id: 'other', runtime: 'ollama', mode: 'pty' }),
  ];
  const closed: string[] = [];
  const opened: Harness['opened'] = [];
  const getAgent = (id: string) => Promise.resolve(agents.find((agent) => agent.id === id));
  const pty: PtyJobs = new PtyJobs({
    store,
    getAgent,
    getDataDir: () => Promise.resolve(dataDir),
    resolveBin: () => Promise.resolve('claude'),
    listConnectors: () => Promise.resolve(connectors),
    listTools: () => [],
    resolveSecret: () => Promise.resolve(null),
    resolveLaunch: createLaunchResolver(() => Promise.resolve('Pacific/Auckland'), {}),
    policy: denyWritesPolicy,
    regisEndpoint: () => Promise.resolve({ url: 'http://127.0.0.1:1/mcp', token: REGIS_TOKEN }),
    openTerminal: (jobId, launch, size) => {
      opened.push({ jobId, launch, ...size });
      return openError ? Promise.reject(openError) : Promise.resolve();
    },
    closeTerminal: (jobId) => {
      closed.push(jobId);
      return Promise.resolve();
    },
    onLog: () => undefined,
  });
  const runner = new JobRunner({
    store,
    getAgent,
    getDriver: () => {
      throw new Error('the headless driver must not run');
    },
    getSetting: () => Promise.resolve(null),
    getDataDir: () => Promise.resolve(dataDir),
    ptyJobs: pty,
    onLog: () => undefined,
  });
  return { store, runner, pty, closed, opened };
}

function argAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

async function headlessJob(store: MemoryJobStore, status: Job['status'], sessionId: string | null) {
  return store.createJob({
    parentId: null,
    agentId: 'head',
    kind: 'task',
    title: 'Headless',
    prompt: 'do it',
    status,
    sessionId,
    cwd: dataDirs[0] ?? null,
    routingReason: null,
    resultText: null,
    error: null,
    startedAt: null,
    endedAt: null,
  });
}

describe('terminal jobs', () => {
  afterEach(() => {
    for (const directory of dataDirs.splice(0)) {
      rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it('starts a pty agent job as running with a session and without a headless run', async () => {
    const { runner } = setup();

    const job = await runner.start({ agentId: 'term', title: 'Terminal', prompt: 'hello' });

    expect(job.status).toBe('running');
    expect(job.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(job.cwd).not.toBeNull();
  });

  it('refuses the terminal mode for a runtime other than Claude Code', async () => {
    const { runner } = setup();

    await expect(runner.start({ agentId: 'other', title: 'T', prompt: 'p' })).rejects.toThrow(/Claude Code/);
  });

  it('writes job-scoped hooks calling job_status_hook and removes them when the job closes', async () => {
    const { runner, pty } = setup();
    const job = await runner.start({ agentId: 'term', title: 'Terminal', prompt: 'hello' });

    const launch: PtyLaunch = await pty.prepare(job.id, false);

    const settingsPath = argAfter(launch.args, '--settings') ?? '';
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      hooks: Record<string, { hooks: Record<string, unknown>[] }[]>;
    };
    expect(settings.hooks.Stop?.[0]?.hooks[0]).toEqual({
      type: 'mcp_tool',
      server: 'regis',
      tool: 'job_status_hook',
      input: { jobId: job.id, event: 'Stop' },
    });
    expect(settings.hooks.Notification?.[0]?.hooks[0]).toMatchObject({
      type: 'mcp_tool',
      tool: 'job_status_hook',
      input: { jobId: job.id, event: 'Notification', message: '${message}' },
    });
    expect(launch.args).toContain('--session-id');
    expect(launch.args.at(-1)).toBe('hello');
    expect(argAfter(launch.args, '--model')).toBe('haiku');
    expect(launch.cwd).toBe(job.cwd);

    await pty.end(job.id, { code: 0, requested: true });

    expect(existsSync(settingsPath)).toBe(false);
    expect(existsSync(dirname(settingsPath))).toBe(false);
  });

  it('passes the regis secret only through the environment', async () => {
    const { runner, pty } = setup();
    const job = await runner.start({ agentId: 'term', title: 'Terminal', prompt: 'hello' });

    const launch = await pty.prepare(job.id, false);

    expect(launch.env[REGIS_TOKEN_ENV]).toBe(REGIS_TOKEN);
    expect(JSON.stringify(launch.args)).not.toContain(REGIS_TOKEN);
    const mcpConfig = readFileSync(argAfter(launch.args, '--mcp-config') ?? '', 'utf8');
    expect(mcpConfig).not.toContain(REGIS_TOKEN);
    expect(mcpConfig).toContain(`\${${REGIS_TOKEN_ENV}}`);
    await pty.end(job.id, { code: 0, requested: true });
  });

  it('writes the launch-time resolved odoo command into the mcp config', async () => {
    const odoo: Connector = { ...buildFromPreset('odoo'), id: 'odoo-1' };
    const { runner, pty } = setup(undefined, [odoo]);
    const job = await runner.start({ agentId: 'term', title: 'Terminal', prompt: 'hello' });

    const launch = await pty.prepare(job.id, false);

    const config = JSON.parse(readFileSync(argAfter(launch.args, '--mcp-config') ?? '', 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.values(config.mcpServers)).toContainEqual(
      expect.objectContaining({
        command: 'node',
        args: [ODOO_DEV_ENTRY],
        env: expect.objectContaining({ REGIS_TIMEZONE: 'Pacific/Auckland' }) as unknown,
      }),
    );
    await pty.end(job.id, { code: 0, requested: true });
  });

  it('resumes a finished headless job with --resume in the job directory and records the arguments', async () => {
    const { store, pty } = setup();
    const job = await headlessJob(store, 'done', 'sess-123');

    const launch = await pty.prepare(job.id, true);

    expect(argAfter(launch.args, '--resume')).toBe('sess-123');
    expect(launch.args).not.toContain('--session-id');
    expect(launch.cwd).toBe(job.cwd);
    const startEvent = store.events.find((event) => event.jobId === job.id && event.type === 'start');
    expect(startEvent?.payloadJson).toMatchObject({ resumed: true, terminal: true, cwd: job.cwd });
    const recordedArgs = (startEvent?.payloadJson as { args: string[] }).args;
    expect(argAfter(recordedArgs, '--resume')).toBe('sess-123');
    expect(store.jobs.get(job.id)?.status).toBe('running');
    await pty.end(job.id, { code: 0, requested: true });
  });

  it('opens the terminal through the host with the secret in env only and returns nothing to the caller', async () => {
    const { runner, pty, opened } = setup();
    const job = await runner.start({ agentId: 'term', title: 'Terminal', prompt: 'hello' });

    const result: unknown = await pty.open(job.id, false, { cols: 100, rows: 30 });

    expect(result).toBeUndefined();
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ jobId: job.id, cols: 100, rows: 30 });
    expect(opened[0]?.launch.env[REGIS_TOKEN_ENV]).toBe(REGIS_TOKEN);
    await pty.end(job.id, { code: 0, requested: true });
  });

  it('restores the previous status when a take-over fails to open the terminal', async () => {
    const { store, pty } = setup(new Error('pty refused'));
    const job = await headlessJob(store, 'waiting_approval', 'sess-9');

    await expect(pty.open(job.id, true, { cols: 80, rows: 24 })).rejects.toThrow('pty refused');

    expect(store.jobs.get(job.id)).toMatchObject({ status: 'waiting_approval', error: null, endedAt: null });
    expect(pty.hasTerminal(job.id)).toBe(false);
  });

  it('allows taking over a job waiting for approval', async () => {
    const { store, pty } = setup();
    const job = await headlessJob(store, 'waiting_approval', 'sess-9');

    await expect(pty.prepare(job.id, true)).resolves.toBeDefined();
    await pty.end(job.id, { code: 0, requested: true });
  });

  it('refuses to take over a running job, a job without session and a second terminal', async () => {
    const { store, pty } = setup();
    const running = await headlessJob(store, 'running', 'sess-1');
    const noSession = await headlessJob(store, 'done', null);
    const done = await headlessJob(store, 'done', 'sess-2');

    await expect(pty.prepare(running.id, true)).rejects.toBeInstanceOf(JobNotResumableError);
    await expect(pty.prepare(noSession.id, true)).rejects.toBeInstanceOf(JobNotResumableError);
    await pty.prepare(done.id, true);
    await expect(pty.prepare(done.id, true)).rejects.toBeInstanceOf(JobNotResumableError);
    await pty.end(done.id, { code: 0, requested: true });
  });

  it('blocks a headless resume while a terminal is open on the job', async () => {
    const { store, runner, pty } = setup();
    const job = await headlessJob(store, 'done', 'sess-3');
    await pty.prepare(job.id, true);

    await expect(runner.resume(job.id, 'more')).rejects.toBeInstanceOf(JobNotResumableError);
    await pty.end(job.id, { code: 0, requested: true });
  });

  it('marks the job failed when the terminal dies on its own with an error code', async () => {
    const { runner, pty, store } = setup();
    const job = await runner.start({ agentId: 'term', title: 'Terminal', prompt: 'hello' });
    await pty.prepare(job.id, false);

    await pty.end(job.id, { code: 3, requested: false });

    expect(store.jobs.get(job.id)).toMatchObject({ status: 'failed' });
  });

  it('keeps the done status set by the Stop hook when the terminal closes', async () => {
    const { runner, pty, store } = setup();
    const job = await runner.start({ agentId: 'term', title: 'Terminal', prompt: 'hello' });
    await pty.prepare(job.id, false);
    await store.updateJob(job.id, { status: 'done' });

    await pty.end(job.id, { code: 1, requested: true });

    expect(store.jobs.get(job.id)?.status).toBe('done');
  });

  it('cancelling a terminal job closes its terminal and cancels it', async () => {
    const { runner, pty, store, closed } = setup();
    const job = await runner.start({ agentId: 'term', title: 'Terminal', prompt: 'hello' });
    await pty.prepare(job.id, false);

    await runner.cancel(job.id);

    expect(closed).toEqual([job.id]);
    expect(store.jobs.get(job.id)?.status).toBe('cancelled');
    await pty.end(job.id, { code: null, requested: true });
  });

  it('does not allow starting the terminal twice for a new job', async () => {
    const { runner, pty } = setup();
    const job = await runner.start({ agentId: 'term', title: 'Terminal', prompt: 'hello' });
    await pty.prepare(job.id, false);
    await pty.end(job.id, { code: 0, requested: true });

    await expect(pty.prepare(job.id, false)).rejects.toBeInstanceOf(JobNotResumableError);
  });
});

describe('buildPtyArgs', () => {
  it('uses --resume for a resumed session and omits the prompt', () => {
    const args = buildPtyArgs({
      settingsPath: 's.json',
      mcpConfigPath: 'm.json',
      sessionId: 'abc',
      resume: true,
      model: null,
      allowedTools: ['mcp__a__read'],
      disallowedTools: ['mcp__a__write'],
    });

    expect(args).toEqual([
      '--settings',
      's.json',
      '--strict-mcp-config',
      '--mcp-config',
      'm.json',
      '--resume',
      'abc',
      '--allowedTools',
      'mcp__a__read',
      '--disallowedTools',
      'mcp__a__write',
    ]);
  });
});

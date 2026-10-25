import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Agent, Job, JobEvent, JobStatus, NewJob, NewJobEvent } from '@regis/shared';
import { resolveClaudeBin } from '../agents/claude-bin';
import type { AgentDriver } from '../agents/driver';
import { ClaudeCliDriver } from '../agents/claude-cli';
import type { RegisMcpEndpoint } from '../regis-mcp/server';
import { denyWritesPolicy } from '../agents/deny-writes-policy';
import { makeAgent } from '../agents/test-support';
import { JobRunner, type JobRunnerDeps, type JobStore } from './runner';

const FAKE_BIN = fileURLToPath(new URL('../../../tests/fake-bins/claude', import.meta.url));

export const fixturePath = (name: string): string =>
  fileURLToPath(new URL(`../../../tests/fixtures/claude-cli/${name}.ndjson`, import.meta.url));

export interface MemoryJobStore extends JobStore {
  jobs: Map<string, Job>;
  events: JobEvent[];
  statusHistory: Map<string, JobStatus[]>;
}

export function createMemoryJobStore(): MemoryJobStore {
  const jobs = new Map<string, Job>();
  const events: JobEvent[] = [];
  const statusHistory = new Map<string, JobStatus[]>();
  let counter = 0;
  const remember = (job: Job): Job => {
    jobs.set(job.id, job);
    const history = statusHistory.get(job.id) ?? [];
    if (history.at(-1) !== job.status) {
      statusHistory.set(job.id, [...history, job.status]);
    }
    return job;
  };
  return {
    jobs,
    events,
    statusHistory,
    createJob: (input: NewJob) => {
      counter += 1;
      return Promise.resolve(
        remember({
          ...input,
          id: `J${String(counter).padStart(4, '0')}`,
          costUsd: 0,
          tokensIn: 0,
          tokensOut: 0,
          createdAt: new Date().toISOString(),
        }),
      );
    },
    getJob: (id) => {
      const job = jobs.get(id);
      return job ? Promise.resolve(job) : Promise.reject(new Error(`unknown job ${id}`));
    },
    updateJob: (id, patch) => {
      const job = jobs.get(id);
      return job
        ? Promise.resolve(remember({ ...job, ...patch } as Job))
        : Promise.reject(new Error(`unknown job ${id}`));
    },
    appendEvent: (event: NewJobEvent) => {
      const stored: JobEvent = {
        ...event,
        id: events.length + 1,
        seq: events.filter((candidate) => candidate.jobId === event.jobId).length + 1,
        payloadJson: event.payloadJson ?? {},
      };
      events.push(stored);
      return Promise.resolve(stored);
    },
    listEvents: (jobId) => Promise.resolve(events.filter((event) => event.jobId === jobId)),
    listJobs: (status) =>
      Promise.resolve([...jobs.values()].filter((job) => status === undefined || job.status === status)),
  };
}

function statelessDriver(agent: Agent): AgentDriver {
  return {
    runtime: agent.runtime,
    // eslint-disable-next-line require-yield
    run: async function* () {
      await Promise.resolve();
    },
    test: () => Promise.resolve({ ok: true, latencyMs: 0, costUsd: 0 }),
  };
}

export interface TestRunner {
  runner: JobRunner;
  store: MemoryJobStore;
  agents: Map<string, Agent>;
  dataDir: string;
  cleanup: () => void;
}

export interface TestRunnerOptions {
  fixture?: string;
  fakeEnv?: Record<string, string>;
  settings?: Record<string, string>;
  agents?: Agent[];
  systemPromptFor?: JobRunnerDeps['systemPromptFor'];
  regisEndpoint?: () => Promise<RegisMcpEndpoint>;
  drivers?: Partial<Record<Agent['runtime'], AgentDriver>>;
}

export function createTestRunner(options: TestRunnerOptions = {}): TestRunner {
  const store = createMemoryJobStore();
  const agents = new Map((options.agents ?? [makeAgent()]).map((agent) => [agent.id, agent]));
  const dataDir = mkdtempSync(join(tmpdir(), 'regis-jobs-'));
  const driver = new ClaudeCliDriver({
    resolveBin: () =>
      resolveClaudeBin({ getSetting: () => Promise.resolve(null), env: { REGIS_CLAUDE_BIN: FAKE_BIN } }),
    listConnectors: () => Promise.resolve([]),
    listTools: () => [],
    resolveSecret: () => Promise.resolve(null),
    policy: options.regisEndpoint
      ? { ...denyWritesPolicy, permissionTool: 'mcp__regis__approve' }
      : denyWritesPolicy,
    ...(options.regisEndpoint ? { regisEndpoint: options.regisEndpoint } : {}),
    onLog: () => undefined,
    extraEnv: { FAKE_CLAUDE_FIXTURE: fixturePath(options.fixture ?? 'simple'), ...options.fakeEnv },
  });
  const runner = new JobRunner({
    store,
    getAgent: (id) => Promise.resolve(agents.get(id)),
    getDriver: (agent) =>
      options.drivers?.[agent.runtime] ?? (agent.runtime === 'claude-cli' ? driver : statelessDriver(agent)),
    getSetting: (key) => Promise.resolve(options.settings?.[key] ?? null),
    getDataDir: () => Promise.resolve(dataDir),
    ...(options.systemPromptFor ? { systemPromptFor: options.systemPromptFor } : {}),
    onLog: () => undefined,
  });
  return {
    runner,
    store,
    agents,
    dataDir,
    cleanup: () => rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  };
}

export async function waitUntil(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('condition not met in time');
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}

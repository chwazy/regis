import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Agent, Connector, Job, ToolInfo } from '@regis/shared';
import type { ConnectorLaunch } from '../mcp/host';
import { REGIS_TOKEN_ENV } from '../agents/claude-cli';
import type { AgentToolPolicy } from '../agents/driver';
import { allowedConnectorIds, buildClaudeEnv, buildMcpConfig } from '../agents/mcp-config';
import { HOOK_TOOL_NAME } from '../regis-mcp/hook-tools';
import { REGIS_AGENT_HEADER, REGIS_JOB_HEADER, type RegisMcpEndpoint } from '../regis-mcp/server';
import { JobNotResumableError, type JobStore, type StartJobInput } from './runner';
import { prepareWorkdir, type WorktreeInfo } from './workdir';

export const REGIS_SERVER_KEY = 'regis';
const RESUMABLE_STATUSES: Job['status'][] = ['done', 'waiting_approval'];
const SETTLED_STATUSES: Job['status'][] = ['done', 'failed', 'cancelled'];

export interface PtyLaunch {
  program: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface PtySize {
  cols: number;
  rows: number;
}

export interface PtyEnd {
  code: number | null;
  requested: boolean;
}

export interface PtyJobsDeps {
  store: JobStore;
  getAgent: (agentId: string) => Promise<Agent | undefined>;
  getDataDir: () => Promise<string>;
  resolveBin: () => Promise<string>;
  listConnectors: () => Promise<Connector[]>;
  listTools: (connectorId: string) => ToolInfo[];
  resolveSecret: (secretRef: string) => Promise<string | null>;
  resolveLaunch?: (connector: Connector) => Promise<ConnectorLaunch | null>;
  policy: AgentToolPolicy;
  regisEndpoint: () => Promise<RegisMcpEndpoint>;
  openTerminal: (jobId: string, launch: PtyLaunch, size: PtySize) => Promise<void>;
  closeTerminal: (jobId: string) => Promise<void>;
  onLog: (line: string) => void;
}

interface OpenTerminal {
  directory: string;
}

interface PendingStart {
  worktree: WorktreeInfo | null;
  contextRefs: { type: string; id: string }[];
}

export function buildPtySettings(jobId: string): Record<string, unknown> {
  const hook = (event: 'Stop' | 'Notification', extraInput: Record<string, string>) => [
    {
      hooks: [
        {
          type: 'mcp_tool',
          server: REGIS_SERVER_KEY,
          tool: HOOK_TOOL_NAME,
          input: { jobId, event, ...extraInput },
        },
      ],
    },
  ];
  return {
    hooks: {
      Stop: hook('Stop', {}),
      Notification: hook('Notification', { message: '${message}' }),
    },
  };
}

export function buildPtyArgs(options: {
  settingsPath: string;
  mcpConfigPath: string;
  sessionId: string;
  resume: boolean;
  model: string | null;
  allowedTools: string[];
  disallowedTools: string[];
  prompt?: string;
}): string[] {
  const args = [
    '--settings',
    options.settingsPath,
    '--strict-mcp-config',
    '--mcp-config',
    options.mcpConfigPath,
  ];
  if (options.model) {
    args.push('--model', options.model);
  }
  args.push(options.resume ? '--resume' : '--session-id', options.sessionId);
  if (options.allowedTools.length > 0) {
    args.push('--allowedTools', options.allowedTools.join(','));
  }
  if (options.disallowedTools.length > 0) {
    args.push('--disallowedTools', options.disallowedTools.join(','));
  }
  if (options.prompt) {
    args.push(options.prompt);
  }
  return args;
}

export class PtyJobs {
  private readonly terminals = new Map<string, OpenTerminal>();
  private readonly pendingStarts = new Map<string, PendingStart>();

  constructor(private readonly deps: PtyJobsDeps) {}

  hasTerminal(jobId: string): boolean {
    return this.terminals.has(jobId);
  }

  async start(input: StartJobInput, agent: Agent): Promise<Job> {
    if (agent.runtime !== 'claude-cli') {
      throw new Error(`Le mode terminal n’est disponible que pour Claude Code (agent ${agent.name})`);
    }
    const created = await this.deps.store.createJob({
      parentId: input.parentId ?? null,
      agentId: agent.id,
      kind: input.kind ?? 'task',
      title: input.title,
      prompt: input.prompt,
      status: 'queued',
      sessionId: null,
      cwd: null,
      routingReason: input.routingReason ?? null,
      resultText: null,
      error: null,
      startedAt: null,
      endedAt: null,
    });
    try {
      const workdir = await prepareWorkdir({
        dataDir: await this.deps.getDataDir(),
        jobId: created.id,
        worktree: agent.worktreePerJob,
        ...(input.repoPath ? { repoPath: input.repoPath } : {}),
        ...(input.cwd ? { cwd: input.cwd } : {}),
      });
      this.pendingStarts.set(created.id, {
        worktree: workdir.worktree,
        contextRefs: input.contextRefs ?? [],
      });
      return await this.deps.store.updateJob(created.id, {
        status: 'running',
        cwd: workdir.cwd,
        sessionId: randomUUID(),
        startedAt: new Date().toISOString(),
      });
    } catch (error) {
      const reason = `Dossier de travail impossible : ${errorMessage(error)}`;
      await this.recordError(created.id, reason);
      return this.deps.store.updateJob(created.id, {
        status: 'failed',
        error: reason,
        endedAt: new Date().toISOString(),
      });
    }
  }

  async open(jobId: string, resume: boolean, size: PtySize): Promise<void> {
    const before = await this.deps.store.getJob(jobId);
    const launch = await this.prepare(jobId, resume);
    try {
      await this.deps.openTerminal(jobId, launch, size);
    } catch (error) {
      await this.discard(jobId);
      const rollback = resume
        ? { status: before.status, error: before.error, endedAt: before.endedAt }
        : {
            status: 'failed' as const,
            error: `Terminal impossible : ${errorMessage(error)}`,
            endedAt: new Date().toISOString(),
          };
      await this.deps.store.updateJob(jobId, rollback).catch(() => undefined);
      throw error;
    }
  }

  async prepare(jobId: string, resume: boolean): Promise<PtyLaunch> {
    const job = await this.deps.store.getJob(jobId);
    const agent = await this.deps.getAgent(job.agentId);
    this.assertCanOpen(job, agent, resume);
    if (!agent || !job.sessionId || !job.cwd) {
      throw new JobNotResumableError(`Le job ${jobId} n’a pas de session ni de dossier de travail`);
    }
    const bin = await this.deps.resolveBin();
    const directory = await mkdtemp(join(tmpdir(), 'regis-pty-'));
    this.terminals.set(jobId, { directory });
    try {
      const allowedIds = new Set(allowedConnectorIds(agent.connectorIdsJson));
      const connectors = (await this.deps.listConnectors()).filter((connector) =>
        allowedIds.has(connector.id),
      );
      const { config, secretEnv } = await buildMcpConfig(
        connectors,
        this.deps.resolveSecret,
        this.deps.resolveLaunch,
      );
      const regis = await this.deps.regisEndpoint();
      config.mcpServers[REGIS_SERVER_KEY] = {
        type: 'http',
        url: regis.url,
        headers: {
          Authorization: `Bearer \${${REGIS_TOKEN_ENV}}`,
          [REGIS_JOB_HEADER]: job.id,
          [REGIS_AGENT_HEADER]: agent.id,
        },
      };
      secretEnv[REGIS_TOKEN_ENV] = regis.token;
      const settingsPath = join(directory, 'settings.json');
      const mcpConfigPath = join(directory, 'mcp.json');
      await writeFile(settingsPath, JSON.stringify(buildPtySettings(job.id)), 'utf8');
      await writeFile(mcpConfigPath, JSON.stringify(config), 'utf8');
      const tools = connectors.flatMap((connector) => this.deps.listTools(connector.id));
      const toolFlags = await this.deps.policy.buildToolFlags(agent, tools);
      const args = buildPtyArgs({
        settingsPath,
        mcpConfigPath,
        sessionId: job.sessionId,
        resume,
        model: agent.model,
        allowedTools: toolFlags.allowed,
        disallowedTools: toolFlags.disallowed,
        ...(resume ? {} : { prompt: job.prompt }),
      });
      await this.recordStart(job, agent, resume, args);
      if (resume) {
        await this.deps.store.updateJob(job.id, { status: 'running', error: null, endedAt: null });
      }
      return { program: bin, args, cwd: job.cwd, env: buildClaudeEnv(secretEnv) };
    } catch (error) {
      await this.discard(jobId);
      throw error;
    }
  }

  private async discard(jobId: string): Promise<void> {
    const terminal = this.terminals.get(jobId);
    this.terminals.delete(jobId);
    if (terminal) {
      await removeQuietly(terminal.directory);
    }
  }

  async end(jobId: string, outcome: PtyEnd): Promise<void> {
    const terminal = this.terminals.get(jobId);
    if (!terminal) {
      return;
    }
    this.terminals.delete(jobId);
    await removeQuietly(terminal.directory);
    const job = await this.deps.store.getJob(jobId);
    const failed = !outcome.requested && outcome.code !== 0;
    if (!SETTLED_STATUSES.includes(job.status)) {
      const reason = `Le terminal s’est arrêté (code ${String(outcome.code)})`;
      await this.deps.store.updateJob(jobId, {
        status: failed ? 'failed' : 'done',
        error: failed ? reason : null,
        endedAt: new Date().toISOString(),
      });
    }
    await this.deps.store
      .appendEvent({
        jobId,
        at: new Date().toISOString(),
        type: failed ? 'error' : 'end',
        summary: failed ? `Terminal arrêté (code ${String(outcome.code)})` : 'Terminal fermé',
        payloadJson: { code: outcome.code, requested: outcome.requested },
      })
      .catch((error: unknown) => {
        this.deps.onLog(`[pty] événement de fin de ${jobId} non enregistré : ${errorMessage(error)}`);
      });
  }

  async closeTerminal(jobId: string): Promise<void> {
    if (this.terminals.has(jobId)) {
      await this.deps.closeTerminal(jobId);
    }
  }

  private assertCanOpen(job: Job, agent: Agent | undefined, resume: boolean): void {
    if (!agent) {
      throw new JobNotResumableError(`Agent introuvable pour le job ${job.id}`);
    }
    if (agent.runtime !== 'claude-cli') {
      throw new JobNotResumableError(`Le runtime ${agent.runtime} ne permet pas le mode terminal`);
    }
    if (this.terminals.has(job.id)) {
      throw new JobNotResumableError(`Un terminal est déjà ouvert pour le job ${job.id}`);
    }
    if (resume) {
      if (!job.sessionId) {
        throw new JobNotResumableError(`Le job ${job.id} n’a pas de session à reprendre`);
      }
      if (!RESUMABLE_STATUSES.includes(job.status)) {
        throw new JobNotResumableError(`Reprendre la main est impossible tant que le job est ${job.status}`);
      }
      return;
    }
    if (agent.mode !== 'pty' || job.status !== 'running' || !this.pendingStarts.has(job.id)) {
      throw new JobNotResumableError(`Le job ${job.id} n’est pas un job terminal à démarrer`);
    }
  }

  private async recordStart(job: Job, agent: Agent, resume: boolean, args: string[]): Promise<void> {
    const pending = this.pendingStarts.get(job.id);
    this.pendingStarts.delete(job.id);
    await this.deps.store.appendEvent({
      jobId: job.id,
      at: new Date().toISOString(),
      type: 'start',
      summary: resume ? 'Reprise en terminal' : 'Terminal ouvert',
      payloadJson: {
        sessionId: job.sessionId,
        model: agent.model,
        cwd: job.cwd,
        resumed: resume,
        terminal: true,
        args,
        ...(pending ? { worktree: pending.worktree, contextRefs: pending.contextRefs } : {}),
      },
    });
  }

  private async recordError(jobId: string, reason: string): Promise<void> {
    await this.deps.store
      .appendEvent({
        jobId,
        at: new Date().toISOString(),
        type: 'error',
        summary: reason,
        payloadJson: { message: reason },
      })
      .catch(() => undefined);
  }
}

async function removeQuietly(directory: string): Promise<void> {
  try {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // dossier temporaire, l'OS finira par le nettoyer
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

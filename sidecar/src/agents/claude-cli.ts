import { spawn as spawnDetached } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import spawn from 'cross-spawn';
import type { Agent, Connector, ToolInfo } from '@regis/shared';
import type { ConnectorLaunch } from '../mcp/host';
import { FIXTURE_CLAUDE_VERSION, claudeCommand, readClaudeVersion } from './claude-bin';
import { buildClaudeArgs, parseClaudeStreamLine } from './claude-stream';
import {
  DriverUnavailableError,
  TEST_PROMPT,
  type AgentDriver,
  type AgentEvent,
  type AgentRunInput,
  type AgentTestResult,
  type AgentToolPolicy,
} from './driver';
import type { RegisMcpEndpoint } from '../regis-mcp/server';
import { REGIS_AGENT_HEADER, REGIS_JOB_HEADER } from '../regis-mcp/server';
import { allowedConnectorIds, buildClaudeEnv, buildMcpConfig } from './mcp-config';

const TEST_TIMEOUT_MS = 60_000;
const STDERR_TAIL_LENGTH = 2000;
const EXIT_WAIT_MS = 2000;
export const REGIS_TOKEN_ENV = 'REGIS_MCP_SECRET_REGIS_INTERNAL';

export interface ClaudeCliDeps {
  resolveBin: () => Promise<string>;
  listConnectors: () => Promise<Connector[]>;
  listTools: (connectorId: string) => ToolInfo[];
  resolveSecret: (secretRef: string) => Promise<string | null>;
  resolveLaunch?: (connector: Connector) => Promise<ConnectorLaunch | null>;
  policy: AgentToolPolicy;
  regisEndpoint?: () => Promise<RegisMcpEndpoint>;
  /** Dossiers des sources de référence, lisibles par l'agent sans être indexés. */
  listReferenceDirs?: () => Promise<string[]>;
  loadsUserConfig?: (agentId: string) => Promise<boolean>;
  onLog: (line: string) => void;
  extraEnv?: Record<string, string>;
}

export class ClaudeCliDriver implements AgentDriver {
  readonly runtime = 'claude-cli' as const;
  readonly supportsResume = true;
  private versionChecked = false;

  constructor(private readonly deps: ClaudeCliDeps) {}

  async checkVersion(bin: string): Promise<void> {
    if (this.versionChecked) {
      return;
    }
    this.versionChecked = true;
    try {
      const version = await readClaudeVersion(bin);
      if (version !== FIXTURE_CLAUDE_VERSION) {
        this.deps.onLog(
          `[agents] Claude Code ${version} diffère de la version des fixtures (${FIXTURE_CLAUDE_VERSION}) : format du flux à revérifier`,
        );
      }
    } catch (error) {
      this.deps.onLog(`[agents] version de Claude Code non vérifiée : ${errorMessage(error)}`);
    }
  }

  async *run(input: AgentRunInput): AsyncGenerator<AgentEvent> {
    const bin = await this.deps.resolveBin();
    await this.checkVersion(bin);
    const workDir = await mkdtemp(join(tmpdir(), 'regis-claude-'));
    try {
      const allowedIds = new Set(allowedConnectorIds(input.agent.connectorIdsJson));
      const connectors = (await this.deps.listConnectors()).filter((connector) =>
        allowedIds.has(connector.id),
      );
      const { config, secretEnv } = await buildMcpConfig(
        connectors,
        this.deps.resolveSecret,
        this.deps.resolveLaunch,
      );
      if (this.deps.regisEndpoint && this.deps.policy.permissionTool) {
        const regis = await this.deps.regisEndpoint();
        config.mcpServers.regis = {
          type: 'http',
          url: regis.url,
          headers: {
            Authorization: `Bearer \${${REGIS_TOKEN_ENV}}`,
            [REGIS_JOB_HEADER]: input.jobId,
            [REGIS_AGENT_HEADER]: input.agent.id,
          },
        };
        secretEnv[REGIS_TOKEN_ENV] = regis.token;
      }
      const mcpConfigPath = join(workDir, 'mcp.json');
      await writeFile(mcpConfigPath, JSON.stringify(config), 'utf8');
      const tools = connectors.flatMap((connector) => this.deps.listTools(connector.id));
      const args = buildClaudeArgs(
        input,
        mcpConfigPath,
        await this.deps.policy.buildToolFlags(input.agent, tools),
        this.deps.regisEndpoint ? this.deps.policy.permissionTool : undefined,
        (await this.deps.listReferenceDirs?.()) ?? [],
        (await this.deps.loadsUserConfig?.(input.agent.id)) ?? false,
      );
      yield* this.stream(bin, args, input, { ...buildClaudeEnv(secretEnv), ...this.deps.extraEnv });
    } finally {
      await removeQuietly(workDir);
    }
  }

  async test(agent: Agent): Promise<AgentTestResult> {
    const startedAt = Date.now();
    const workDir = await mkdtemp(join(tmpdir(), 'regis-claude-test-'));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
    let costUsd = 0;
    try {
      const input: AgentRunInput = {
        jobId: 'agent-test',
        agent: { ...agent, connectorIdsJson: [] },
        prompt: TEST_PROMPT,
        cwd: workDir,
        signal: controller.signal,
      };
      for await (const event of this.run(input)) {
        if (event.type === 'usage') {
          costUsd = event.costUsd;
        } else if (event.type === 'error') {
          return { ok: false, latencyMs: Date.now() - startedAt, costUsd, error: event.message };
        } else if (event.type === 'end') {
          return {
            ok: !event.isError,
            latencyMs: Date.now() - startedAt,
            costUsd,
            ...(event.isError ? { error: event.resultText || event.subtype || 'Échec du test' } : {}),
          };
        }
      }
      return { ok: false, latencyMs: Date.now() - startedAt, costUsd, error: 'Flux terminé sans résultat' };
    } catch (error) {
      return { ok: false, latencyMs: Date.now() - startedAt, costUsd, error: errorMessage(error) };
    } finally {
      clearTimeout(timer);
      await removeQuietly(workDir);
    }
  }

  private async *stream(
    bin: string,
    args: string[],
    input: AgentRunInput,
    env: Record<string, string>,
  ): AsyncGenerator<AgentEvent> {
    const command = claudeCommand(bin, args);
    const child = spawn(command.command, command.args, {
      cwd: input.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stderrTail = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_LENGTH);
    });
    const spawnFailure = new Promise<Error>((resolveFailure) => {
      child.once('error', resolveFailure);
    });
    const exited = new Promise<number | null>((resolveExit) => {
      child.once('close', (code) => resolveExit(code));
    });
    const kill = (): void => killProcessTree(child.pid, () => child.kill('SIGKILL'));
    input.signal.addEventListener('abort', kill, { once: true });
    if (input.signal.aborted) {
      kill();
    }
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(input.prompt);

    let ended = false;
    try {
      const lines = createInterface({ input: child.stdout as NodeJS.ReadableStream, crlfDelay: Infinity });
      const failedToSpawn = await Promise.race([
        spawnFailure,
        (async (): Promise<undefined> => {
          await new Promise<void>((resolveSpawn) => child.once('spawn', resolveSpawn));
          return undefined;
        })(),
      ]);
      if (failedToSpawn) {
        throw new DriverUnavailableError(`Impossible de lancer ${bin} : ${failedToSpawn.message}`);
      }
      for await (const line of lines) {
        for (const event of parseClaudeStreamLine(line)) {
          ended = ended || event.type === 'end';
          yield event;
        }
      }
      const code = await exited;
      if (input.signal.aborted) {
        yield { type: 'end', resultText: '', isError: true, subtype: 'aborted' };
      } else if (!ended) {
        const detail = stderrTail.trim();
        yield {
          type: 'error',
          message: `claude s’est arrêté (code ${String(code)})${detail ? ` : ${detail}` : ''}`,
        };
      }
    } finally {
      input.signal.removeEventListener('abort', kill);
      if (child.exitCode === null && child.signalCode === null) {
        kill();
        await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, EXIT_WAIT_MS))]);
      }
    }
  }
}

async function removeQuietly(directory: string): Promise<void> {
  try {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // dossier temporaire, l'OS finira par le nettoyer
  }
}

export function killProcessTree(pid: number | undefined, fallback: () => void): void {
  if (pid === undefined) {
    fallback();
    return;
  }
  if (process.platform === 'win32') {
    spawnDetached('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on(
      'error',
      fallback,
    );
    return;
  }
  fallback();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

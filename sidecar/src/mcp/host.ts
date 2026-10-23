import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';
import type {
  Connector,
  ConnectorState,
  ConnectorStatus,
  McpTestResult,
  ToolAccess,
  ToolInfo,
} from '@regis/shared';
import { classifyTool } from './classify';

export type { ConnectorState, ConnectorStatus, ToolInfo };

export class McpCallError extends Error {
  constructor(
    public connectorId: string,
    public tool: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ConnectorLaunch {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpHostOptions {
  resolveLaunch?: (connector: Connector) => Promise<ConnectorLaunch | null>;
  resolveSecret: (secretRef: string) => Promise<string | null>;
  onStatus: (status: ConnectorStatus) => void;
  onLog: (line: string) => void;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  stdioStartTimeoutMs?: number;
  httpStartTimeoutMs?: number;
  callTimeoutMs?: number;
}

const DEFAULT_INITIAL_BACKOFF_MS = 1000;
const DEFAULT_MAX_BACKOFF_MS = 60_000;
const DEFAULT_STDIO_START_TIMEOUT_MS = 60_000;
const DEFAULT_HTTP_START_TIMEOUT_MS = 30_000;
const DEFAULT_CALL_TIMEOUT_MS = 60_000;
const STABLE_UPTIME_MS = 30_000;
const GRACEFUL_STOP_MS = 1800;
const DEFAULT_SECRET_ENV = 'REGIS_CONNECTOR_SECRET';
const DOWNLOADING_RUNNERS = new Set(['npx', 'uvx', 'pnpx', 'bunx']);

const stringList = z.array(z.string());
const stringRecord = z.record(z.string(), z.string());
const syncSettings = z.object({
  secretEnv: z.string().optional(),
  toolAccess: z.record(z.string(), z.enum(['read', 'write'])).optional(),
});

type RemoteTool = Awaited<ReturnType<Client['listTools']>>['tools'][number];

interface ConnectorSettings {
  args: string[];
  env: Record<string, string>;
  secretEnv: string;
  toolAccess: Record<string, ToolAccess>;
}

interface ConnectorEntry {
  connector: Connector;
  status: ConnectorStatus;
  tools: ToolInfo[];
  client?: Client;
  transport?: Transport;
  secrets: string[];
  wanted: boolean;
  generation: number;
  attempt: number;
  connectedAt?: number;
  retryTimer?: NodeJS.Timeout;
}

interface OpenConnection {
  client: Client;
  transport: Transport;
  secrets: string[];
}

class OpenError extends Error {
  constructor(
    readonly secrets: string[],
    readonly reason: unknown,
  ) {
    super(errorMessage(reason));
  }
}

export function qualifyToolName(connectorName: string, toolName: string): string {
  const normalized = connectorName.toLowerCase().replace(/[^a-z0-9_-]+/g, '_');
  return `mcp__${normalized}__${toolName}`;
}

export class McpHost {
  private readonly entries = new Map<string, ConnectorEntry>();

  constructor(private readonly options: McpHostOptions) {}

  async start(connector: Connector): Promise<ConnectorStatus> {
    const entry = this.entryFor(connector);
    entry.connector = connector;
    entry.wanted = true;
    entry.attempt = 0;
    await this.disconnect(entry);
    return this.connect(entry);
  }

  async stop(connectorId: string): Promise<void> {
    const entry = this.entries.get(connectorId);
    if (!entry) {
      return;
    }
    entry.wanted = false;
    await this.disconnect(entry);
    this.publish(entry, 'stopped');
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((connectorId) => this.stop(connectorId)));
  }

  status(connectorId: string): ConnectorStatus {
    return (
      this.entries.get(connectorId)?.status ?? {
        connectorId,
        state: 'stopped',
        toolCount: 0,
        since: new Date().toISOString(),
      }
    );
  }

  listTools(connectorId?: string): ToolInfo[] {
    if (connectorId !== undefined) {
      return [...(this.entries.get(connectorId)?.tools ?? [])];
    }
    return [...this.entries.values()].flatMap((entry) => entry.tools);
  }

  async callTool(
    connectorId: string,
    tool: string,
    args: unknown,
    opts?: { timeoutMs?: number },
  ): Promise<unknown> {
    const entry = this.entries.get(connectorId);
    if (!entry?.client || entry.status.state !== 'connected') {
      throw new McpCallError(connectorId, tool, `Connector ${connectorId} is not connected`);
    }
    try {
      return await entry.client.callTool(
        { name: tool, arguments: (args ?? {}) as Record<string, unknown> },
        undefined,
        { timeout: opts?.timeoutMs ?? this.options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS },
      );
    } catch (error) {
      throw new McpCallError(connectorId, tool, redact(entry.secrets, errorMessage(error)));
    }
  }

  async test(connector: Connector): Promise<McpTestResult> {
    const startedAt = Date.now();
    const live = this.entries.get(connector.id);
    if (live?.client && live.status.state === 'connected') {
      try {
        const tools = await this.fetchTools(live.client);
        return { ok: true, toolCount: tools.length, latencyMs: Date.now() - startedAt };
      } catch (error) {
        return failure(redact(live.secrets, errorMessage(error)), startedAt);
      }
    }
    let connection: OpenConnection | undefined;
    try {
      connection = await this.open(connector, () => undefined);
      const tools = await this.fetchTools(connection.client);
      return { ok: true, toolCount: tools.length, latencyMs: Date.now() - startedAt };
    } catch (error) {
      return failure(this.describeStartError(connector, error, connection?.secrets ?? []), startedAt);
    } finally {
      if (connection) {
        await this.closeConnection(connection.client, connection.transport);
      }
    }
  }

  private entryFor(connector: Connector): ConnectorEntry {
    const existing = this.entries.get(connector.id);
    if (existing) {
      return existing;
    }
    const entry: ConnectorEntry = {
      connector,
      status: { connectorId: connector.id, state: 'stopped', toolCount: 0, since: new Date().toISOString() },
      tools: [],
      secrets: [],
      wanted: false,
      generation: 0,
      attempt: 0,
    };
    this.entries.set(connector.id, entry);
    return entry;
  }

  private publish(entry: ConnectorEntry, state: ConnectorState, error?: string): void {
    entry.status = {
      connectorId: entry.connector.id,
      state,
      toolCount: state === 'connected' ? entry.tools.length : 0,
      since: new Date().toISOString(),
      ...(error === undefined ? {} : { error }),
    };
    this.options.onStatus(entry.status);
  }

  private async connect(entry: ConnectorEntry): Promise<ConnectorStatus> {
    entry.generation += 1;
    const generation = entry.generation;
    const isCurrent = (): boolean => entry.generation === generation && entry.wanted;
    this.publish(entry, 'starting');
    let connection: OpenConnection | undefined;
    try {
      connection = await this.open(entry.connector, (reason) => {
        if (isCurrent() && entry.client !== undefined) {
          this.handleUnexpectedClose(entry, reason);
        }
      });
      entry.secrets = connection.secrets;
      const tools = await this.fetchTools(connection.client);
      if (!isCurrent()) {
        await this.closeConnection(connection.client, connection.transport);
        return entry.status;
      }
      entry.client = connection.client;
      entry.transport = connection.transport;
      entry.tools = this.describeTools(entry.connector, tools);
      entry.connectedAt = Date.now();
      this.publish(entry, 'connected');
    } catch (error) {
      const message = this.describeStartError(entry.connector, error, connection?.secrets ?? []);
      if (connection) {
        await this.closeConnection(connection.client, connection.transport);
      }
      if (isCurrent()) {
        this.options.onLog(`[mcp:${entry.connector.name}] ${message}`);
        this.publish(entry, 'error', message);
        this.scheduleRestart(entry);
      }
    }
    return entry.status;
  }

  private handleUnexpectedClose(entry: ConnectorEntry, reason: string): void {
    const uptime = entry.connectedAt === undefined ? 0 : Date.now() - entry.connectedAt;
    if (uptime >= STABLE_UPTIME_MS) {
      entry.attempt = 0;
    }
    entry.client = undefined;
    entry.transport = undefined;
    entry.tools = [];
    entry.connectedAt = undefined;
    this.options.onLog(`[mcp:${entry.connector.name}] connection closed: ${reason}`);
    this.publish(entry, 'error', reason);
    this.scheduleRestart(entry);
  }

  private scheduleRestart(entry: ConnectorEntry): void {
    if (!entry.wanted || entry.retryTimer) {
      return;
    }
    const initial = this.options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
    const max = this.options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    const delay = Math.min(initial * 2 ** entry.attempt, max);
    entry.attempt += 1;
    entry.retryTimer = setTimeout(() => {
      entry.retryTimer = undefined;
      if (entry.wanted) {
        void this.connect(entry);
      }
    }, delay);
  }

  private async disconnect(entry: ConnectorEntry): Promise<void> {
    entry.generation += 1;
    if (entry.retryTimer) {
      clearTimeout(entry.retryTimer);
      entry.retryTimer = undefined;
    }
    const { client, transport } = entry;
    entry.client = undefined;
    entry.transport = undefined;
    entry.tools = [];
    entry.connectedAt = undefined;
    if (client && transport) {
      await this.closeConnection(client, transport);
    }
  }

  private async open(connector: Connector, onClosed: (reason: string) => void): Promise<OpenConnection> {
    const secrets: string[] = [];
    const client = new Client({ name: 'regis', version: '0.1.0' });
    let transport: Transport;
    try {
      const launch = (await this.options.resolveLaunch?.(connector)) ?? null;
      const settings = withLaunch(parseSettings(connector), launch);
      const secret = connector.secretRef ? await this.options.resolveSecret(connector.secretRef) : null;
      if (secret) {
        secrets.push(secret);
      }
      transport = this.createTransport(connector, settings, launch?.command, secret, secrets);
    } catch (error) {
      throw new OpenError(secrets, error);
    }
    transport.onerror = (error) => {
      this.options.onLog(`[mcp:${connector.name}] ${redact(secrets, errorMessage(error))}`);
    };
    client.onclose = () => onClosed('Le serveur MCP s’est arrêté');
    const timeout =
      connector.transport === 'stdio'
        ? (this.options.stdioStartTimeoutMs ?? DEFAULT_STDIO_START_TIMEOUT_MS)
        : (this.options.httpStartTimeoutMs ?? DEFAULT_HTTP_START_TIMEOUT_MS);
    if (connector.transport === 'stdio' && DOWNLOADING_RUNNERS.has(commandName(connector.command))) {
      this.options.onLog(`[mcp:${connector.name}] premier lancement : téléchargement en cours`);
    }
    try {
      await client.connect(transport, { timeout });
    } catch (error) {
      await this.closeConnection(client, transport);
      throw new OpenError(secrets, error);
    }
    return { client, transport, secrets };
  }

  private createTransport(
    connector: Connector,
    settings: ConnectorSettings,
    commandOverride: string | undefined,
    secret: string | null,
    secrets: string[],
  ): Transport {
    if (connector.transport === 'stdio') {
      const command = commandOverride ?? connector.command;
      if (!command) {
        throw new Error('Commande manquante pour le connecteur stdio');
      }
      const env = { ...settings.env, ...(secret ? { [settings.secretEnv]: secret } : {}) };
      const stdio = new StdioClientTransport({
        command,
        args: settings.args,
        env,
        stderr: 'pipe',
      });
      this.forwardStderr(stdio, connector.name, secrets);
      return stdio;
    }
    if (connector.transport === 'http') {
      if (!connector.url) {
        throw new Error('URL manquante pour le connecteur HTTP');
      }
      const headers: Record<string, string> = secret ? { Authorization: `Bearer ${secret}` } : {};
      return new StreamableHTTPClientTransport(new URL(connector.url), { requestInit: { headers } });
    }
    throw new Error(`Transport non pris en charge : ${connector.transport}`);
  }

  private forwardStderr(transport: StdioClientTransport, name: string, secrets: string[]): void {
    let pending = '';
    transport.stderr?.on('data', (chunk: Buffer) => {
      pending += chunk.toString('utf8');
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim().length > 0) {
          this.options.onLog(`[mcp:${name}] ${redact(secrets, line)}`);
        }
      }
    });
  }

  private async fetchTools(client: Client): Promise<RemoteTool[]> {
    const tools: RemoteTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor === undefined ? undefined : { cursor });
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }

  private describeTools(connector: Connector, tools: RemoteTool[]): ToolInfo[] {
    const overrides = parseSettings(connector).toolAccess;
    return tools.map((tool) => ({
      connectorId: connector.id,
      name: tool.name,
      qualifiedName: qualifyToolName(connector.name, tool.name),
      ...(tool.description === undefined ? {} : { description: tool.description }),
      inputSchema: tool.inputSchema,
      access: classifyTool(tool, overrides[tool.name]),
      ...(tool.annotations?.readOnlyHint === undefined
        ? {}
        : { readOnlyHint: tool.annotations.readOnlyHint }),
    }));
  }

  private describeStartError(connector: Connector, error: unknown, knownSecrets: string[]): string {
    const secrets = error instanceof OpenError ? error.secrets : knownSecrets;
    const cause = error instanceof OpenError ? error.reason : error;
    const message = redact(secrets, errorMessage(cause));
    const timedOut = /timed out|timeout/i.test(message);
    if (
      timedOut &&
      connector.transport === 'stdio' &&
      DOWNLOADING_RUNNERS.has(commandName(connector.command))
    ) {
      return `${message} (premier lancement : téléchargement en cours ?)`;
    }
    return message;
  }

  private async closeConnection(client: Client, transport: Transport): Promise<void> {
    client.onclose = undefined;
    const pid = transport instanceof StdioClientTransport ? transport.pid : null;
    const graceTimer =
      pid === null
        ? undefined
        : setTimeout(() => {
            if (isAlive(pid)) {
              killProcessTree(pid);
            }
          }, GRACEFUL_STOP_MS);
    try {
      await client.close();
    } catch {
      // transport déjà fermé
    } finally {
      if (graceTimer) {
        clearTimeout(graceTimer);
      }
    }
  }
}

function parseSettings(connector: Connector): ConnectorSettings {
  const sync = syncSettings.safeParse(connector.syncJson);
  return {
    args: stringList.catch([]).parse(connector.argsJson),
    env: stringRecord.catch({}).parse(connector.envJson),
    secretEnv: (sync.success ? sync.data.secretEnv : undefined) ?? DEFAULT_SECRET_ENV,
    toolAccess: (sync.success ? sync.data.toolAccess : undefined) ?? {},
  };
}

function withLaunch(settings: ConnectorSettings, launch: ConnectorLaunch | null): ConnectorSettings {
  if (!launch) {
    return settings;
  }
  return {
    ...settings,
    args: launch.args ?? settings.args,
    env: { ...settings.env, ...launch.env },
  };
}

function redact(secrets: string[], text: string): string {
  return secrets.reduce((result, secret) => (secret ? result.split(secret).join('***') : result), text);
}

function commandName(command: string | null): string {
  const base = (command ?? '').split(/[\\/]/).pop() ?? '';
  return base.toLowerCase().replace(/\.(cmd|exe|bat)$/, '');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failure(error: string, startedAt: number): McpTestResult {
  return { ok: false, toolCount: 0, error, latencyMs: Date.now() - startedAt };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on(
      'error',
      () => undefined,
    );
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // processus déjà terminé
  }
}

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import spawn from 'cross-spawn';
import { z } from 'zod';
import type { Agent, ToolInfo } from '@regis/shared';
import { locateOnPath } from './claude-bin';
import { killProcessTree } from './claude-cli';
import {
  DriverUnavailableError,
  TEST_PROMPT,
  type AgentDriver,
  type AgentEvent,
  type AgentRunInput,
  type AgentTestResult,
  type AgentToolPolicy,
} from './driver';
import { buildMinimalEnv } from './mcp-config';

export const ACP_PROTOCOL_VERSION = 1;
export const GEMINI_BIN_ENV = 'REGIS_GEMINI_BIN';
export const GEMINI_BIN_SETTING = 'agents.geminiBin';
export const GEMINI_API_KEY_ENV = 'GEMINI_API_KEY';
export const ACP_ENABLED = false;

const TEST_TIMEOUT_MS = 60_000;
const CANCEL_GRACE_MS = 3000;
const EXIT_WAIT_MS = 2000;
const STDERR_TAIL_LENGTH = 2000;
const MAX_SUMMARY_LENGTH = 200;
const METHOD_NOT_FOUND = -32601;
const CLIENT_INFO = { name: 'regis', title: 'Régis', version: '0.1.0' };

const envelope = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});
type Envelope = z.infer<typeof envelope>;

const initializeResult = z.object({ protocolVersion: z.number() });
const newSessionResult = z.object({ sessionId: z.string().min(1) });
const promptResult = z.object({ stopReason: z.string() });
const updateParams = z.object({ update: z.object({ sessionUpdate: z.string() }).loose() });
const textContent = z.object({ type: z.literal('text'), text: z.string() });
const messageChunk = z.object({ content: textContent, messageId: z.string().optional() });
const toolCallUpdate = z.object({
  toolCallId: z.string(),
  title: z.string().optional(),
  status: z.string().optional(),
  rawInput: z.unknown().optional(),
  content: z.array(z.unknown()).nullish(),
});
const toolContentBlock = z.object({ type: z.literal('content'), content: textContent });
const permissionParams = z.object({
  toolCall: z
    .object({
      toolCallId: z.string(),
      title: z.string().nullish(),
      kind: z.string().nullish(),
      rawInput: z.unknown().optional(),
    })
    .optional(),
  options: z.array(z.object({ optionId: z.string(), kind: z.string() })),
});
type PermissionOutcome = { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' };

export interface AcpCommand {
  command: string;
  args: string[];
}

export interface AcpDeps {
  runtime: Agent['runtime'];
  resolveCommand: (agent: Agent) => Promise<AcpCommand>;
  policy: AgentToolPolicy;
  resolveSecret?: (secretRef: string) => Promise<string | null>;
  secretEnvName?: string;
  extraEnv?: Record<string, string>;
  onLog: (line: string) => void;
}

export interface GeminiBinSources {
  getSetting: (key: string) => Promise<string | null>;
  env?: NodeJS.ProcessEnv;
}

export async function resolveGeminiCommand(sources: GeminiBinSources, agent: Agent): Promise<AcpCommand> {
  const env = sources.env ?? process.env;
  const configured = env[GEMINI_BIN_ENV] || (await sources.getSetting(GEMINI_BIN_SETTING)) || 'gemini';
  const found = /[\\/]/.test(configured)
    ? [resolve(configured)].find((path) => existsSync(path))
    : locateOnPath(configured, env);
  if (!found) {
    throw new DriverUnavailableError(
      `Gemini CLI est introuvable dans le PATH (réglage ${GEMINI_BIN_SETTING})`,
    );
  }
  return {
    command: found,
    args: ['--acp', '--approval-mode', 'default', ...(agent.model ? ['--model', agent.model] : [])],
  };
}

export class UpdateMapper {
  private pending = '';
  private segment = '';
  private all = '';
  private messageId: string | undefined;

  push(update: { sessionUpdate: string }): AgentEvent[] {
    if (update.sessionUpdate === 'agent_message_chunk') {
      const chunk = messageChunk.safeParse(update);
      if (!chunk.success) {
        return [];
      }
      const events = chunk.data.messageId !== this.messageId ? this.flush() : [];
      this.messageId = chunk.data.messageId;
      this.pending += chunk.data.content.text;
      return events;
    }
    if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      const call = toolCallUpdate.safeParse(update);
      if (!call.success) {
        return [];
      }
      const events = this.flush();
      if (update.sessionUpdate === 'tool_call') {
        this.segment = '';
        events.push({
          type: 'tool_call',
          toolUseId: call.data.toolCallId,
          tool: call.data.title ?? 'tool',
          input: call.data.rawInput ?? {},
        });
      }
      if (call.data.status === 'completed' || call.data.status === 'failed') {
        events.push({
          type: 'tool_result',
          toolUseId: call.data.toolCallId,
          ok: call.data.status === 'completed',
          summary: toolSummary(call.data),
        });
      }
      return events;
    }
    return [];
  }

  flush(): AgentEvent[] {
    if (this.pending === '') {
      return [];
    }
    const text = this.pending;
    this.pending = '';
    this.segment += text;
    this.all += text;
    return [{ type: 'message', text }];
  }

  get resultText(): string {
    return this.segment.trim() === '' ? this.all : this.segment;
  }
}

function toolSummary(call: z.infer<typeof toolCallUpdate>): string {
  const text = (call.content ?? [])
    .map((block) => toolContentBlock.safeParse(block))
    .flatMap((parsed) => (parsed.success ? [parsed.data.content.text] : []))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (text || call.title || call.status || '').slice(0, MAX_SUMMARY_LENGTH);
}

class EventQueue {
  private readonly items: AgentEvent[] = [];
  private closed = false;
  private wake: (() => void) | undefined;

  push(event: AgentEvent): void {
    this.items.push(event);
    this.notify();
  }

  close(): void {
    this.closed = true;
    this.notify();
  }

  async *drain(): AsyncGenerator<AgentEvent> {
    for (;;) {
      const next = this.items.shift();
      if (next) {
        yield next;
      } else if (this.closed) {
        return;
      } else {
        await new Promise<void>((resolveWait) => {
          this.wake = resolveWait;
        });
      }
    }
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }
}

export class AcpDriver implements AgentDriver {
  readonly runtime: Agent['runtime'];

  constructor(private readonly deps: AcpDeps) {
    this.runtime = deps.runtime;
  }

  async *run(input: AgentRunInput): AsyncGenerator<AgentEvent> {
    const queue = new EventQueue();
    const stop = new AbortController();
    const forwardAbort = (): void => stop.abort();
    input.signal.addEventListener('abort', forwardAbort, { once: true });
    let unavailable: DriverUnavailableError | undefined;
    const session = this.runSession(input, stop.signal, queue)
      .catch((error: unknown) => {
        if (error instanceof DriverUnavailableError) {
          unavailable = error;
        } else {
          queue.push({ type: 'error', message: errorMessage(error) });
        }
      })
      .finally(() => queue.close());
    try {
      yield* queue.drain();
      await session;
      if (unavailable) {
        throw unavailable;
      }
    } finally {
      input.signal.removeEventListener('abort', forwardAbort);
      stop.abort();
    }
  }

  async test(agent: Agent): Promise<AgentTestResult> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
    try {
      const input: AgentRunInput = {
        jobId: 'agent-test',
        agent: { ...agent, connectorIdsJson: [] },
        prompt: TEST_PROMPT,
        cwd: process.cwd(),
        signal: controller.signal,
      };
      for await (const event of this.run(input)) {
        if (event.type === 'error') {
          return { ok: false, latencyMs: Date.now() - startedAt, costUsd: 0, error: event.message };
        }
        if (event.type === 'end') {
          return {
            ok: !event.isError,
            latencyMs: Date.now() - startedAt,
            costUsd: 0,
            ...(event.isError ? { error: event.resultText || event.subtype || 'Échec du test' } : {}),
          };
        }
      }
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        costUsd: 0,
        error: 'Flux terminé sans résultat',
      };
    } catch (error) {
      return { ok: false, latencyMs: Date.now() - startedAt, costUsd: 0, error: errorMessage(error) };
    } finally {
      clearTimeout(timer);
    }
  }

  private async childEnv(agent: Agent): Promise<Record<string, string>> {
    const secretEnv: Record<string, string> = {};
    if (agent.secretRef && this.deps.resolveSecret) {
      const secret = await this.deps.resolveSecret(agent.secretRef);
      if (secret) {
        secretEnv[this.deps.secretEnvName ?? GEMINI_API_KEY_ENV] = secret;
      }
    }
    return { ...buildMinimalEnv(secretEnv), ...this.deps.extraEnv };
  }

  private async decidePermission(
    input: AgentRunInput,
    params: unknown,
    knownCalls: Map<string, { title?: string; rawInput?: unknown }>,
  ): Promise<PermissionOutcome> {
    const parsed = permissionParams.safeParse(params);
    if (!parsed.success) {
      return rejectOutcome(params);
    }
    const call = parsed.data.toolCall;
    const known = call ? knownCalls.get(call.toolCallId) : undefined;
    const name = call?.title ?? known?.title ?? call?.kind ?? call?.toolCallId ?? 'acp-tool';
    const tool: ToolInfo = { connectorId: '', name, qualifiedName: name, inputSchema: {}, access: 'write' };
    const decision = await this.deps.policy.authorizeTool(
      input.agent,
      tool,
      call?.rawInput ?? known?.rawInput ?? {},
      { jobId: input.jobId },
    );
    if (!decision.allow) {
      this.deps.onLog(`[acp] permission refusée pour ${name} : ${decision.message}`);
      return rejectOutcome(params);
    }
    return allowOutcome(params);
  }

  private async runSession(input: AgentRunInput, signal: AbortSignal, queue: EventQueue): Promise<void> {
    const { command, args } = await this.deps.resolveCommand(input.agent);
    const child = spawn(command, args, {
      cwd: input.cwd,
      env: await this.childEnv(input.agent),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stderrTail = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_LENGTH);
    });
    const exited = new Promise<number | null>((resolveExit) => {
      child.once('close', (code) => resolveExit(code));
    });
    const spawnFailure = new Promise<Error>((resolveFailure) => {
      child.once('error', resolveFailure);
    });
    child.stdin?.on('error', () => undefined);

    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: Error) => void }>();
    const mapper = new UpdateMapper();
    let sessionId: string | undefined;
    let nextId = 0;
    let aborted = false;

    const write = (message: Record<string, unknown>): void => {
      child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    };
    const request = (method: string, params: unknown): Promise<unknown> =>
      new Promise((resolveRequest, rejectRequest) => {
        nextId += 1;
        pending.set(nextId, { resolve: resolveRequest, reject: rejectRequest });
        write({ id: nextId, method, params });
      });
    const failPending = (reason: Error): void => {
      for (const entry of pending.values()) {
        entry.reject(reason);
      }
      pending.clear();
    };

    const toolCalls = new Map<string, { title?: string; rawInput?: unknown }>();
    const answerPermission = async (id: number | string, params: unknown): Promise<void> => {
      let outcome: PermissionOutcome;
      try {
        outcome = await this.decidePermission(input, params, toolCalls);
      } catch (error) {
        this.deps.onLog(`[acp] politique d’outils indisponible : ${errorMessage(error)}`);
        outcome = rejectOutcome(params);
      }
      write({ id, result: { outcome: aborted ? { outcome: 'cancelled' } : outcome } });
    };
    const answerRequest = (message: Envelope): void => {
      if (message.id === undefined) {
        return;
      }
      if (message.method === 'session/request_permission') {
        void answerPermission(message.id, message.params);
        return;
      }
      write({
        id: message.id,
        error: { code: METHOD_NOT_FOUND, message: `Méthode non prise en charge : ${message.method ?? ''}` },
      });
    };

    const handleLine = (line: string): void => {
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        this.deps.onLog(`[acp] ligne non JSON ignorée : ${line.slice(0, MAX_SUMMARY_LENGTH)}`);
        return;
      }
      const parsed = envelope.safeParse(raw);
      if (!parsed.success) {
        return;
      }
      const message = parsed.data;
      if (message.method !== undefined) {
        if (message.id !== undefined) {
          answerRequest(message);
        } else if (message.method === 'session/update') {
          const update = updateParams.safeParse(message.params);
          if (update.success) {
            rememberToolCall(update.data.update, toolCalls);
            for (const event of mapper.push(update.data.update)) {
              queue.push(event);
            }
          }
        }
        return;
      }
      if (typeof message.id !== 'number') {
        return;
      }
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) {
        entry?.reject(new Error(message.error.message));
      } else {
        entry?.resolve(message.result);
      }
    };

    const kill = (): void => killProcessTree(child.pid, () => child.kill('SIGKILL'));
    let cancelTimer: NodeJS.Timeout | undefined;
    const onAbort = (): void => {
      aborted = true;
      if (sessionId) {
        write({ method: 'session/cancel', params: { sessionId } });
        cancelTimer = setTimeout(kill, CANCEL_GRACE_MS);
      } else {
        kill();
      }
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }

    const lines = createInterface({ input: child.stdout as NodeJS.ReadableStream, crlfDelay: Infinity });
    lines.on('line', handleLine);
    void exited.then((code) => {
      failPending(new Error(`le processus s’est arrêté (code ${String(code)})`));
    });
    void spawnFailure.then((error) => {
      failPending(new DriverUnavailableError(`Impossible de lancer ${command} : ${error.message}`));
    });

    try {
      const initialized = initializeResult.parse(
        await request('initialize', {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo: CLIENT_INFO,
        }),
      );
      if (initialized.protocolVersion !== ACP_PROTOCOL_VERSION) {
        throw new Error(
          `Version ACP ${String(initialized.protocolVersion)} non prise en charge (attendue : ${String(ACP_PROTOCOL_VERSION)})`,
        );
      }
      sessionId = newSessionResult.parse(
        await request('session/new', { cwd: input.cwd, mcpServers: [] }),
      ).sessionId;
      queue.push({
        type: 'start',
        sessionId,
        ...(input.agent.model ? { model: input.agent.model } : {}),
      });
      const text = input.systemPrompt ? `${input.systemPrompt}\n\n${input.prompt}` : input.prompt;
      const outcome = promptResult.parse(
        await request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }),
      );
      for (const event of mapper.flush()) {
        queue.push(event);
      }
      queue.push(endEvent(outcome.stopReason, aborted, mapper.resultText));
    } catch (error) {
      for (const event of mapper.flush()) {
        queue.push(event);
      }
      if (aborted) {
        queue.push({ type: 'end', resultText: '', isError: true, subtype: 'aborted' });
      } else if (error instanceof DriverUnavailableError) {
        throw error;
      } else {
        const detail = stderrTail.trim();
        queue.push({ type: 'error', message: `${errorMessage(error)}${detail ? ` : ${detail}` : ''}` });
      }
    } finally {
      clearTimeout(cancelTimer);
      signal.removeEventListener('abort', onAbort);
      lines.close();
      child.stdin?.end();
      if (child.exitCode === null && child.signalCode === null) {
        kill();
        await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, EXIT_WAIT_MS))]);
      }
    }
  }
}

function rememberToolCall(
  update: { sessionUpdate: string },
  toolCalls: Map<string, { title?: string; rawInput?: unknown }>,
): void {
  if (update.sessionUpdate !== 'tool_call') {
    return;
  }
  const call = toolCallUpdate.safeParse(update);
  if (call.success) {
    toolCalls.set(call.data.toolCallId, {
      ...(call.data.title ? { title: call.data.title } : {}),
      ...(call.data.rawInput !== undefined ? { rawInput: call.data.rawInput } : {}),
    });
  }
}

function pickOutcome(params: unknown, kinds: string[]): PermissionOutcome {
  const parsed = permissionParams.safeParse(params);
  const options = parsed.success ? parsed.data.options : [];
  for (const kind of kinds) {
    const option = options.find((candidate) => candidate.kind === kind);
    if (option) {
      return { outcome: 'selected', optionId: option.optionId };
    }
  }
  return { outcome: 'cancelled' };
}

function rejectOutcome(params: unknown): PermissionOutcome {
  return pickOutcome(params, ['reject_once', 'reject_always']);
}

function allowOutcome(params: unknown): PermissionOutcome {
  return pickOutcome(params, ['allow_once', 'allow_always']);
}

function endEvent(stopReason: string, aborted: boolean, resultText: string): AgentEvent {
  if (aborted || stopReason === 'cancelled') {
    return { type: 'end', resultText: '', isError: true, subtype: 'aborted' };
  }
  return { type: 'end', resultText, isError: stopReason !== 'end_turn', subtype: stopReason };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import type { Agent, AgentRuntime, ToolInfo } from '@regis/shared';

export interface AgentRunInput {
  jobId: string;
  agent: Agent;
  prompt: string;
  systemPrompt?: string;
  cwd: string;
  sessionId?: string;
  resume?: boolean;
  maxTurns?: number;
  jsonOutput?: boolean;
  signal: AbortSignal;
}

export type AgentEvent =
  | { type: 'start'; sessionId?: string; model?: string }
  | { type: 'message'; text: string }
  | { type: 'tool_call'; toolUseId: string; tool: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; ok: boolean; summary: string }
  | { type: 'usage'; costUsd: number; tokensIn: number; tokensOut: number }
  | { type: 'end'; resultText: string; isError: boolean; subtype?: string }
  | { type: 'error'; message: string };

export interface AgentTestResult {
  ok: boolean;
  latencyMs: number;
  costUsd: number;
  error?: string;
}

export interface AgentDriver {
  readonly runtime: AgentRuntime;
  readonly supportsResume?: boolean;
  run(input: AgentRunInput): AsyncIterable<AgentEvent>;
  test(agent: Agent): Promise<AgentTestResult>;
}

export class DriverUnavailableError extends Error {}

export interface ToolFlags {
  allowed: string[];
  disallowed: string[];
}

export type ToolDecision = { allow: true; updatedInput?: unknown } | { allow: false; message: string };

export interface AgentToolPolicy {
  buildToolFlags(agent: Agent, tools: ToolInfo[]): ToolFlags | Promise<ToolFlags>;
  permissionTool?: string;
  authorizeTool(
    agent: Agent,
    tool: ToolInfo,
    input: unknown,
    context: { jobId: string },
  ): Promise<ToolDecision>;
}

export const TEST_PROMPT = 'Reply with the single word: pong';

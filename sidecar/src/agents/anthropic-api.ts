import Anthropic from '@anthropic-ai/sdk';
import type { Agent, ToolInfo } from '@regis/shared';
import { summarizeToolContent } from './claude-stream';
import {
  DriverUnavailableError,
  TEST_PROMPT,
  type AgentDriver,
  type AgentEvent,
  type AgentRunInput,
  type AgentTestResult,
  type AgentToolPolicy,
} from './driver';
import { allowedConnectorIds } from './mcp-config';

export const DEFAULT_API_MODEL_SETTING = 'agents.defaultApiModel';
const DEFAULT_MAX_TURNS = 10;
const DEFAULT_MAX_TOKENS = 4096;
const TEST_MAX_TOKENS = 64;

export interface ToolCaller {
  listTools: (connectorId?: string) => ToolInfo[];
  callTool: (connectorId: string, tool: string, args: unknown) => Promise<unknown>;
}

export interface AnthropicApiDeps {
  resolveSecret: (secretRef: string) => Promise<string | null>;
  getSetting: (key: string) => Promise<string | null>;
  tools: ToolCaller;
  policy: AgentToolPolicy;
  fetch?: typeof fetch;
}

export class AnthropicApiDriver implements AgentDriver {
  readonly runtime = 'anthropic-api' as const;
  readonly supportsHistory = true;

  constructor(private readonly deps: AnthropicApiDeps) {}

  async *run(input: AgentRunInput): AsyncGenerator<AgentEvent> {
    const { agent } = input;
    const client = await this.createClient(agent);
    const model = await this.resolveModel(agent);
    const tools = allowedConnectorIds(agent.connectorIdsJson).flatMap((id) => this.deps.tools.listTools(id));
    const apiTools: Anthropic.Messages.Tool[] = tools.map((tool) => ({
      name: tool.qualifiedName,
      description: tool.description ?? '',
      input_schema: tool.inputSchema as Anthropic.Messages.Tool.InputSchema,
    }));
    const maxTurns = input.maxTurns ?? DEFAULT_MAX_TURNS;
    const messages: Anthropic.Messages.MessageParam[] = [
      ...(input.history ?? []).map((turn) => ({ role: turn.role, content: turn.text })),
      { role: 'user', content: input.prompt },
    ];
    let lastText = '';
    yield { type: 'start', model };

    for (let turn = 1; turn <= maxTurns; turn += 1) {
      let response: Anthropic.Messages.Message;
      try {
        response = await client.messages.create(
          {
            model,
            max_tokens: DEFAULT_MAX_TOKENS,
            messages,
            ...(input.systemPrompt ? { system: input.systemPrompt } : {}),
            ...(apiTools.length > 0 ? { tools: apiTools } : {}),
          },
          { signal: input.signal },
        );
      } catch (error) {
        if (input.signal.aborted) {
          yield { type: 'end', resultText: lastText, isError: true, subtype: 'aborted' };
        } else {
          yield { type: 'error', message: errorMessage(error) };
        }
        return;
      }
      yield {
        type: 'usage',
        costUsd: 0,
        tokensIn: response.usage.input_tokens,
        tokensOut: response.usage.output_tokens,
      };
      const toolUses: Anthropic.Messages.ToolUseBlock[] = [];
      const texts: string[] = [];
      for (const block of response.content) {
        if (block.type === 'text') {
          texts.push(block.text);
          yield { type: 'message', text: block.text };
        } else if (block.type === 'tool_use') {
          toolUses.push(block);
          yield { type: 'tool_call', toolUseId: block.id, tool: block.name, input: block.input };
        }
      }
      lastText = texts.join('\n');
      if (response.stop_reason !== 'tool_use' || toolUses.length === 0) {
        yield {
          type: 'end',
          resultText: lastText,
          isError: response.stop_reason === 'refusal',
          ...(response.stop_reason ? { subtype: response.stop_reason } : {}),
        };
        return;
      }
      const results: Anthropic.Messages.ToolResultBlockParam[] = [];
      for (const toolUse of toolUses) {
        const outcome = await this.executeTool(agent, tools, toolUse, input.jobId);
        yield {
          type: 'tool_result',
          toolUseId: toolUse.id,
          ok: outcome.ok,
          summary: summarizeToolContent(outcome.text),
        };
        results.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: outcome.text,
          ...(outcome.ok ? {} : { is_error: true }),
        });
      }
      messages.push({ role: 'assistant', content: response.content }, { role: 'user', content: results });
    }
    yield { type: 'end', resultText: lastText, isError: true, subtype: 'max_turns' };
  }

  async test(agent: Agent): Promise<AgentTestResult> {
    const startedAt = Date.now();
    try {
      const client = await this.createClient(agent);
      const model = await this.resolveModel(agent);
      await client.messages.create({
        model,
        max_tokens: TEST_MAX_TOKENS,
        messages: [{ role: 'user', content: TEST_PROMPT }],
      });
      return { ok: true, latencyMs: Date.now() - startedAt, costUsd: 0 };
    } catch (error) {
      return { ok: false, latencyMs: Date.now() - startedAt, costUsd: 0, error: errorMessage(error) };
    }
  }

  private async createClient(agent: Agent): Promise<Anthropic> {
    if (!agent.secretRef) {
      throw new DriverUnavailableError('Aucune clé API configurée pour cet agent');
    }
    const apiKey = await this.deps.resolveSecret(agent.secretRef);
    if (!apiKey) {
      throw new DriverUnavailableError('Clé API absente du coffre de l’OS');
    }
    return new Anthropic({
      apiKey,
      maxRetries: 0,
      ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
    });
  }

  private async resolveModel(agent: Agent): Promise<string> {
    const model = agent.model || (await this.deps.getSetting(DEFAULT_API_MODEL_SETTING));
    if (!model) {
      throw new DriverUnavailableError('Aucun modèle configuré (réglage agents.defaultApiModel)');
    }
    return model;
  }

  private async executeTool(
    agent: Agent,
    tools: ToolInfo[],
    toolUse: Anthropic.Messages.ToolUseBlock,
    jobId: string,
  ): Promise<{ ok: boolean; text: string }> {
    const tool = tools.find((candidate) => candidate.qualifiedName === toolUse.name);
    if (!tool) {
      return { ok: false, text: `Outil inconnu : ${toolUse.name}` };
    }
    const decision = await this.deps.policy.authorizeTool(agent, tool, toolUse.input, { jobId });
    if (!decision.allow) {
      return { ok: false, text: decision.message };
    }
    try {
      const result = await this.deps.tools.callTool(
        tool.connectorId,
        tool.name,
        decision.updatedInput ?? toolUse.input,
      );
      return mcpResultToText(result);
    } catch (error) {
      return { ok: false, text: errorMessage(error) };
    }
  }
}

function mcpResultToText(result: unknown): { ok: boolean; text: string } {
  const record = (typeof result === 'object' && result !== null ? result : {}) as {
    content?: unknown;
    isError?: unknown;
  };
  const text = Array.isArray(record.content)
    ? record.content
        .map((part: unknown) => (isTextPart(part) ? part.text : ''))
        .filter((part) => part !== '')
        .join('\n')
    : JSON.stringify(result);
  return { ok: record.isError !== true, text };
}

function isTextPart(part: unknown): part is { text: string } {
  return typeof part === 'object' && part !== null && typeof (part as { text?: unknown }).text === 'string';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

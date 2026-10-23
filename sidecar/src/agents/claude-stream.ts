import { z } from 'zod';
import type { AgentEvent, AgentRunInput, ToolFlags } from './driver';

const MAX_SUMMARY_LENGTH = 500;

const textBlock = z.object({ type: z.literal('text'), text: z.string() });
const toolUseBlock = z.object({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
});
const toolResultBlock = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z.unknown().optional(),
  is_error: z.boolean().optional(),
});

const initEvent = z.object({
  type: z.literal('system'),
  subtype: z.literal('init'),
  session_id: z.string().optional(),
  model: z.string().optional(),
});
const messageEvent = z.object({
  type: z.enum(['assistant', 'user']),
  message: z.object({ content: z.array(z.unknown()) }),
});
const modelUsageEntry = z.object({
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  cacheReadInputTokens: z.number().optional(),
  cacheCreationInputTokens: z.number().optional(),
  costUSD: z.number().optional(),
});
const resultEvent = z.object({
  type: z.literal('result'),
  subtype: z.string().optional(),
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  total_cost_usd: z.number().optional(),
  usage: z
    .object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
      cache_creation_input_tokens: z.number().optional(),
      cache_read_input_tokens: z.number().optional(),
    })
    .optional(),
  modelUsage: z.record(z.string(), modelUsageEntry).optional(),
});

export function parseClaudeStreamLine(line: string): AgentEvent[] {
  const trimmed = line.trim();
  if (trimmed === '') {
    return [];
  }
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const init = initEvent.safeParse(raw);
  if (init.success) {
    return [
      {
        type: 'start',
        ...(init.data.session_id === undefined ? {} : { sessionId: init.data.session_id }),
        ...(init.data.model === undefined ? {} : { model: init.data.model }),
      },
    ];
  }
  const message = messageEvent.safeParse(raw);
  if (message.success) {
    return message.data.message.content.flatMap(parseContentBlock);
  }
  const result = resultEvent.safeParse(raw);
  if (result.success) {
    return parseResult(result.data);
  }
  return [];
}

function parseContentBlock(block: unknown): AgentEvent[] {
  const text = textBlock.safeParse(block);
  if (text.success) {
    return text.data.text === '' ? [] : [{ type: 'message', text: text.data.text }];
  }
  const toolUse = toolUseBlock.safeParse(block);
  if (toolUse.success) {
    return [
      { type: 'tool_call', toolUseId: toolUse.data.id, tool: toolUse.data.name, input: toolUse.data.input },
    ];
  }
  const toolResult = toolResultBlock.safeParse(block);
  if (toolResult.success) {
    return [
      {
        type: 'tool_result',
        toolUseId: toolResult.data.tool_use_id,
        ok: toolResult.data.is_error !== true,
        summary: summarizeToolContent(toolResult.data.content),
      },
    ];
  }
  return [];
}

function parseResult(result: z.infer<typeof resultEvent>): AgentEvent[] {
  return [
    { type: 'usage', ...accountUsage(result) },
    {
      type: 'end',
      resultText: result.result ?? '',
      isError: result.is_error ?? false,
      ...(result.subtype === undefined ? {} : { subtype: result.subtype }),
    },
  ];
}

function accountUsage(result: z.infer<typeof resultEvent>): {
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
} {
  const perModel = Object.values(result.modelUsage ?? {});
  if (perModel.length > 0) {
    return {
      costUsd: perModel.reduce((sum, entry) => sum + (entry.costUSD ?? 0), 0),
      tokensIn: perModel.reduce(
        (sum, entry) =>
          sum +
          (entry.inputTokens ?? 0) +
          (entry.cacheCreationInputTokens ?? 0) +
          (entry.cacheReadInputTokens ?? 0),
        0,
      ),
      tokensOut: perModel.reduce((sum, entry) => sum + (entry.outputTokens ?? 0), 0),
    };
  }
  const usage = result.usage;
  return {
    costUsd: result.total_cost_usd ?? 0,
    tokensIn:
      (usage?.input_tokens ?? 0) +
      (usage?.cache_creation_input_tokens ?? 0) +
      (usage?.cache_read_input_tokens ?? 0),
    tokensOut: usage?.output_tokens ?? 0,
  };
}

export function summarizeToolContent(content: unknown): string {
  if (typeof content === 'string') {
    return truncate(content);
  }
  if (Array.isArray(content)) {
    const parts = content.map((part: unknown) => {
      const record = (typeof part === 'object' && part !== null ? part : {}) as Record<string, unknown>;
      if (typeof record.text === 'string') {
        return record.text;
      }
      if (typeof record.tool_name === 'string') {
        return record.tool_name;
      }
      return '';
    });
    return truncate(parts.filter((part) => part !== '').join('\n'));
  }
  return '';
}

function truncate(text: string): string {
  return text.length > MAX_SUMMARY_LENGTH ? `${text.slice(0, MAX_SUMMARY_LENGTH)}…` : text;
}

export function buildClaudeArgs(
  input: AgentRunInput,
  mcpConfigPath: string,
  toolFlags: ToolFlags,
  permissionTool?: string,
): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  args.push('--setting-sources', 'project', '--strict-mcp-config', '--mcp-config', mcpConfigPath);
  if (input.agent.model) {
    args.push('--model', input.agent.model);
  }
  if (input.resume === true && input.sessionId) {
    args.push('--resume', input.sessionId);
  } else if (input.sessionId) {
    args.push('--session-id', input.sessionId);
  }
  if (input.systemPrompt) {
    args.push('--append-system-prompt', input.systemPrompt);
  }
  if (toolFlags.allowed.length > 0) {
    args.push('--allowedTools', toolFlags.allowed.join(','));
  }
  if (toolFlags.disallowed.length > 0) {
    args.push('--disallowedTools', toolFlags.disallowed.join(','));
  }
  if (permissionTool) {
    args.push('--permission-prompt-tool', permissionTool);
  }
  if (input.agent.budgetDailyUsd !== null) {
    args.push('--max-budget-usd', String(input.agent.budgetDailyUsd));
  }
  return args;
}

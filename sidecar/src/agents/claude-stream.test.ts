import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildClaudeArgs,
  CLAUDE_LOGIN_MESSAGE,
  isClaudeLoginFailure,
  parseClaudeStreamLine,
} from './claude-stream';
import type { AgentEvent } from './driver';
import { makeAgent, makeRunInput } from './test-support';

function replay(name: string): AgentEvent[] {
  const path = fileURLToPath(new URL(`../../../tests/fixtures/claude-cli/${name}.ndjson`, import.meta.url));
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '' && !('_meta' in (JSON.parse(line) as object)))
    .flatMap(parseClaudeStreamLine);
}

const NO_TOOL_FLAGS = { allowed: [], disallowed: [] };

describe('parseClaudeStreamLine', () => {
  it('replays simple.ndjson as start, message, usage, end', () => {
    const events = replay('simple');

    expect(events.map((event) => event.type)).toEqual(['start', 'message', 'usage', 'end']);
    expect(events[0]).toMatchObject({ type: 'start', sessionId: '1d8ddcb6-f9d2-4b0e-b7b9-48661de71ba0' });
    expect(events[1]).toMatchObject({ type: 'message', text: 'pong' });
    expect(events[2]).toMatchObject({ type: 'usage', costUsd: 0.00028688 });
    expect(events[3]).toMatchObject({ type: 'end', isError: false, resultText: 'pong' });
  });

  it('turns an expired Claude Code login into an explicit error before the end', () => {
    const events = replay('auth-expired');

    expect(events.map((event) => event.type)).toEqual(['start', 'message', 'usage', 'error', 'end']);
    expect(events[3]).toEqual({ type: 'error', message: CLAUDE_LOGIN_MESSAGE });
    expect(events[4]).toMatchObject({ type: 'end', isError: true });
  });

  it('only flags failed results whose text is a login failure', () => {
    expect(
      isClaudeLoginFailure('Failed to authenticate: OAuth session expired and could not be refreshed'),
    ).toBe(true);
    expect(isClaudeLoginFailure('I failed to authenticate against the Odoo API')).toBe(false);
    expect(replay('simple').some((event) => event.type === 'error')).toBe(false);
  });

  it('accounts tokens and cost from modelUsage on every fixture', () => {
    const expectations: Record<string, { costUsd: number; tokensIn: number; tokensOut: number }> = {
      simple: { costUsd: 0.00028688, tokensIn: 28470, tokensOut: 4 },
      'tool-use': { costUsd: 0.00123966, tokensIn: 87755, tokensOut: 380 },
    };
    for (const [name, expected] of Object.entries(expectations)) {
      expect(replay(name).find((event) => event.type === 'usage')).toMatchObject(expected);
    }
    for (const name of ['permission-allow', 'permission-allow-updated', 'permission-deny']) {
      const usage = replay(name).find((event) => event.type === 'usage');
      expect(usage?.type === 'usage' && usage.costUsd).toBeGreaterThan(0);
    }
  });

  it('sums modelUsage over models and falls back to usage when absent', () => {
    const base = { type: 'result', subtype: 'success', is_error: false, result: 'x' };
    const summed = parseClaudeStreamLine(
      JSON.stringify({
        ...base,
        total_cost_usd: 1,
        usage: { input_tokens: 1, output_tokens: 1 },
        modelUsage: {
          a: {
            inputTokens: 10,
            outputTokens: 2,
            cacheReadInputTokens: 5,
            cacheCreationInputTokens: 1,
            costUSD: 0.5,
          },
          b: { inputTokens: 3, outputTokens: 4, costUSD: 0.25 },
        },
      }),
    );
    const fallback = parseClaudeStreamLine(
      JSON.stringify({ ...base, total_cost_usd: 1, usage: { input_tokens: 7, output_tokens: 3 } }),
    );

    expect(summed[0]).toEqual({ type: 'usage', costUsd: 0.75, tokensIn: 19, tokensOut: 6 });
    expect(fallback[0]).toEqual({ type: 'usage', costUsd: 1, tokensIn: 7, tokensOut: 3 });
  });

  it('pairs tool_call and tool_result on tool-use.ndjson', () => {
    const events = replay('tool-use');
    const call = events.find((event) => event.type === 'tool_call' && event.tool.startsWith('mcp__'));
    const result = events.find(
      (event) =>
        event.type === 'tool_result' && call?.type === 'tool_call' && event.toolUseId === call.toolUseId,
    );

    expect(call).toBeDefined();
    expect(result).toMatchObject({ type: 'tool_result', ok: true });
    expect(events.at(-1)).toMatchObject({ type: 'end', isError: false });
  });

  it('keeps internal tool calls and flags refused tool results on permission-deny.ndjson', () => {
    const events = replay('permission-deny');

    expect(events.some((event) => event.type === 'tool_call' && event.tool === 'ToolSearch')).toBe(true);
    expect(events.some((event) => event.type === 'tool_result' && !event.ok)).toBe(true);
  });

  it('ignores unknown, malformed and empty lines', () => {
    expect(parseClaudeStreamLine('')).toEqual([]);
    expect(parseClaudeStreamLine('not json')).toEqual([]);
    expect(parseClaudeStreamLine('{"type":"rate_limit_event"}')).toEqual([]);
    expect(parseClaudeStreamLine('{"type":"system","subtype":"hook_started"}')).toEqual([]);
    expect(parseClaudeStreamLine('{"type":"assistant","message":{"content":[{"type":"thinking"}]}}')).toEqual(
      [],
    );
  });
});

describe('buildClaudeArgs', () => {
  it('opens the reference folders to the agent with --add-dir, and nothing without them', () => {
    const withDirs = buildClaudeArgs(makeRunInput(), 'mcp.json', NO_TOOL_FLAGS, undefined, [
      'C:/git/regis',
      'C:/git/spellcache',
    ]);
    const index = withDirs.indexOf('--add-dir');
    expect(withDirs.slice(index, index + 3)).toEqual(['--add-dir', 'C:/git/regis', 'C:/git/spellcache']);
    expect(withDirs[index + 3]?.startsWith('--')).toBe(true);
    expect(buildClaudeArgs(makeRunInput(), 'mcp.json', NO_TOOL_FLAGS)).not.toContain('--add-dir');
  });

  it('always contains the headless stream-json flags', () => {
    const args = buildClaudeArgs(makeRunInput(), 'mcp.json', NO_TOOL_FLAGS);

    expect(args).toEqual(expect.arrayContaining(['-p', '--output-format', 'stream-json', '--verbose']));
    expect(args).toEqual(expect.arrayContaining(['--mcp-config', 'mcp.json', '--strict-mcp-config']));
    expect(args).not.toContain('--max-budget-usd');
    expect(args).not.toContain('--resume');
  });

  it('adds --resume only when resuming a session', () => {
    const resumed = buildClaudeArgs(
      makeRunInput({ sessionId: 's-1', resume: true }),
      'mcp.json',
      NO_TOOL_FLAGS,
    );
    const fresh = buildClaudeArgs(makeRunInput({ sessionId: 's-1' }), 'mcp.json', NO_TOOL_FLAGS);

    expect(resumed.slice(resumed.indexOf('--resume'), resumed.indexOf('--resume') + 2)).toEqual([
      '--resume',
      's-1',
    ]);
    expect(resumed).not.toContain('--session-id');
    expect(fresh).toEqual(expect.arrayContaining(['--session-id', 's-1']));
    expect(fresh).not.toContain('--resume');
  });

  it('adds --max-budget-usd only when the agent has a daily budget', () => {
    const args = buildClaudeArgs(
      makeRunInput({ agent: makeAgent({ budgetDailyUsd: 2.5 }) }),
      'm.json',
      NO_TOOL_FLAGS,
    );

    expect(args).toEqual(expect.arrayContaining(['--max-budget-usd', '2.5']));
  });

  it('passes tool flags, permission tool, model and system prompt', () => {
    const args = buildClaudeArgs(
      makeRunInput({ agent: makeAgent({ model: 'haiku' }), systemPrompt: 'be brief' }),
      'm.json',
      { allowed: ['mcp__a__read'], disallowed: ['mcp__a__write', 'Bash'] },
      'mcp__regis__approve',
    );

    expect(args).toEqual(
      expect.arrayContaining([
        '--allowedTools',
        'mcp__a__read',
        '--disallowedTools',
        'mcp__a__write,Bash',
        '--permission-prompt-tool',
        'mcp__regis__approve',
        '--model',
        'haiku',
        '--append-system-prompt',
        'be brief',
      ]),
    );
  });
});

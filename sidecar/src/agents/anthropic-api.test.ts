import { describe, expect, it } from 'vitest';
import type { ToolInfo } from '@regis/shared';
import { AnthropicApiDriver, type ToolCaller } from './anthropic-api';
import { denyWritesPolicy } from './deny-writes-policy';
import { DriverUnavailableError } from './driver';
import { createToolPolicy } from '../policy/tool-policy';
import { collect, makeAgent, makeRunInput } from './test-support';

interface RecordedRequest {
  body: {
    model: string;
    max_tokens: number;
    messages: { role: string; content: unknown }[];
    tools?: { name: string }[];
  };
}

function messageResponse(content: unknown[], stopReason: string): Response {
  return new Response(
    JSON.stringify({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-5-5',
      content,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: { input_tokens: 11, output_tokens: 7 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function mockFetch(responses: (() => Response)[]): { fetch: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const queue = [...responses];
  const mocked = (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requests.push({ body: JSON.parse(String(init?.body)) as RecordedRequest['body'] });
    const next = queue.shift();
    return Promise.resolve(next ? next() : messageResponse([{ type: 'text', text: 'done' }], 'end_turn'));
  };
  return { fetch: mocked as typeof fetch, requests };
}

const READ_TOOL: ToolInfo = {
  connectorId: 'c1',
  name: 'read_text_file',
  qualifiedName: 'mcp__filesystem__read_text_file',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  access: 'read',
};
const WRITE_TOOL: ToolInfo = {
  connectorId: 'c1',
  name: 'write_file',
  qualifiedName: 'mcp__filesystem__write_file',
  inputSchema: { type: 'object', properties: {} },
  access: 'write',
};

function toolCaller(calls: { tool: string; args: unknown }[]): ToolCaller {
  return {
    listTools: () => [READ_TOOL, WRITE_TOOL],
    callTool: (_connectorId, tool, args) => {
      calls.push({ tool, args });
      return Promise.resolve({ content: [{ type: 'text', text: 'file content' }] });
    },
  };
}

function driverWith(
  fetchImpl: typeof fetch,
  calls: { tool: string; args: unknown }[] = [],
): AnthropicApiDriver {
  return new AnthropicApiDriver({
    resolveSecret: () => Promise.resolve('test-key'),
    getSetting: () => Promise.resolve(null),
    tools: toolCaller(calls),
    policy: denyWritesPolicy,
    fetch: fetchImpl,
  });
}

const apiAgent = makeAgent({
  runtime: 'anthropic-api',
  mode: 'api',
  model: 'claude-haiku-5-5',
  secretRef: 'agent-anthropic-api',
  connectorIdsJson: ['c1'],
});

describe('AnthropicApiDriver', () => {
  it('calls the MCP tool, sends the tool_result back and stops on end_turn', async () => {
    const { fetch: fetchImpl, requests } = mockFetch([
      () =>
        messageResponse(
          [{ type: 'tool_use', id: 'toolu_1', name: READ_TOOL.qualifiedName, input: { path: 'a.txt' } }],
          'tool_use',
        ),
      () => messageResponse([{ type: 'text', text: 'It says hello' }], 'end_turn'),
    ]);
    const calls: { tool: string; args: unknown }[] = [];

    const events = await collect(
      driverWith(fetchImpl, calls).run(makeRunInput({ agent: apiAgent, prompt: 'read a.txt' })),
    );

    expect(calls).toEqual([{ tool: 'read_text_file', args: { path: 'a.txt' } }]);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.body.tools?.map((tool) => tool.name)).toContain(READ_TOOL.qualifiedName);
    const secondMessages = requests[1]?.body.messages ?? [];
    expect(JSON.stringify(secondMessages.at(-1))).toContain('"tool_use_id":"toolu_1"');
    expect(events.map((event) => event.type)).toEqual([
      'start',
      'usage',
      'tool_call',
      'tool_result',
      'usage',
      'message',
      'end',
    ]);
    expect(events.at(-1)).toMatchObject({
      type: 'end',
      isError: false,
      subtype: 'end_turn',
      resultText: 'It says hello',
    });
  });

  it('stops after maxTurns with the max_turns subtype', async () => {
    const loop = (): Response =>
      messageResponse(
        [{ type: 'tool_use', id: 'toolu_x', name: READ_TOOL.qualifiedName, input: {} }],
        'tool_use',
      );
    const { fetch: fetchImpl, requests } = mockFetch([loop, loop, loop, loop]);

    const events = await collect(driverWith(fetchImpl).run(makeRunInput({ agent: apiAgent, maxTurns: 2 })));

    expect(requests).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ type: 'end', subtype: 'max_turns', isError: true });
  });

  it('refuses write tools through the policy without calling the connector', async () => {
    const { fetch: fetchImpl } = mockFetch([
      () =>
        messageResponse(
          [{ type: 'tool_use', id: 'toolu_w', name: WRITE_TOOL.qualifiedName, input: { path: 'x' } }],
          'tool_use',
        ),
    ]);
    const calls: { tool: string; args: unknown }[] = [];

    const events = await collect(driverWith(fetchImpl, calls).run(makeRunInput({ agent: apiAgent })));

    expect(calls).toEqual([]);
    expect(events.find((event) => event.type === 'tool_result')).toMatchObject({ ok: false });
  });

  it('never forwards a denied tool and tells the model it is forbidden by the policy', async () => {
    const { fetch: fetchImpl, requests } = mockFetch([
      () =>
        messageResponse(
          [{ type: 'tool_use', id: 'toolu_d', name: WRITE_TOOL.qualifiedName, input: { path: 'x' } }],
          'tool_use',
        ),
      () => messageResponse([{ type: 'text', text: 'ok' }], 'end_turn'),
    ]);
    const calls: { tool: string; args: unknown }[] = [];
    const policy = createToolPolicy({
      listRules: () =>
        Promise.resolve([{ agentId: null, toolPattern: 'mcp__filesystem__write*', policy: 'deny' }]),
      approvals: { request: () => Promise.reject(new Error('no approval expected')) },
    });
    const driver = new AnthropicApiDriver({
      resolveSecret: () => Promise.resolve('test-key'),
      getSetting: () => Promise.resolve(null),
      tools: toolCaller(calls),
      policy,
      fetch: fetchImpl,
    });

    await collect(driver.run(makeRunInput({ agent: apiAgent })));

    expect(calls).toEqual([]);
    const toolResult = JSON.stringify(requests[1]?.body.messages.at(-1));
    expect(toolResult).toContain('"is_error":true');
    expect(toolResult).toContain('interdit par la politique');
  });

  it('is unavailable when the API key is missing from the secret store', async () => {
    const driver = new AnthropicApiDriver({
      resolveSecret: () => Promise.resolve(null),
      getSetting: () => Promise.resolve(null),
      tools: toolCaller([]),
      policy: denyWritesPolicy,
    });

    await expect(collect(driver.run(makeRunInput({ agent: apiAgent })))).rejects.toBeInstanceOf(
      DriverUnavailableError,
    );
    expect((await driver.test(apiAgent)).ok).toBe(false);
  });

  it('falls back to the agents.defaultApiModel setting when the agent has no model', async () => {
    const { fetch: fetchImpl, requests } = mockFetch([]);
    const driver = new AnthropicApiDriver({
      resolveSecret: () => Promise.resolve('test-key'),
      getSetting: (key) => Promise.resolve(key === 'agents.defaultApiModel' ? 'model-from-setting' : null),
      tools: toolCaller([]),
      policy: denyWritesPolicy,
      fetch: fetchImpl,
    });

    await collect(driver.run(makeRunInput({ agent: { ...apiAgent, model: null } })));

    expect(requests[0]?.body.model).toBe('model-from-setting');
  });
});

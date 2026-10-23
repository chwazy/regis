import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AcpDriver, resolveGeminiCommand, UpdateMapper } from './acp';
import { DriverUnavailableError, type AgentEvent, type AgentToolPolicy, type ToolDecision } from './driver';
import { denyWritesPolicy } from './deny-writes-policy';
import { collect, makeAgent, makeRunInput } from './test-support';

const FAKE_AGENT = fileURLToPath(new URL('../../../tests/fake-bins/fake-acp-agent.mjs', import.meta.url));

function driverIn(
  mode: string,
  overrides: Partial<ConstructorParameters<typeof AcpDriver>[0]> = {},
): AcpDriver {
  return new AcpDriver({
    runtime: 'gemini-cli',
    resolveCommand: () => Promise.resolve({ command: process.execPath, args: [FAKE_AGENT] }),
    extraEnv: { FAKE_ACP_MODE: mode },
    policy: denyWritesPolicy,
    onLog: () => undefined,
    ...overrides,
  });
}

const geminiAgent = makeAgent({ runtime: 'gemini-cli', mode: 'acp' });

function policyReturning(decision: ToolDecision, calls: unknown[] = []): AgentToolPolicy {
  return {
    ...denyWritesPolicy,
    authorizeTool: (_agent, tool, input, context) => {
      calls.push({ tool: tool.qualifiedName, input, jobId: context.jobId });
      return Promise.resolve(decision);
    },
  };
}

function messageTexts(events: AgentEvent[]): string[] {
  return events.flatMap((event) => (event.type === 'message' ? [event.text] : []));
}

describe('AcpDriver', () => {
  it('emits start, message and end in AgentEvent format', async () => {
    const events = await collect(driverIn('simple').run(makeRunInput({ agent: geminiAgent })));

    expect(events).toEqual([
      { type: 'start', sessionId: 'sess_fake_1' },
      { type: 'message', text: 'Hello' },
      { type: 'end', resultText: 'Hello', isError: false, subtype: 'end_turn' },
    ]);
  });

  it('maps tool calls and keeps the answer after the last tool as the result', async () => {
    const events = await collect(driverIn('tool').run(makeRunInput({ agent: geminiAgent })));

    expect(events.map((event) => event.type)).toEqual([
      'start',
      'message',
      'tool_call',
      'tool_result',
      'message',
      'end',
    ]);
    expect(events.at(-1)).toMatchObject({ resultText: 'Done', isError: false });
    expect(events.find((event) => event.type === 'tool_result')).toMatchObject({
      ok: true,
      summary: 'contents',
    });
  });

  it('allows a permission request when the Régis policy says auto', async () => {
    const calls: unknown[] = [];
    const policy = policyReturning({ allow: true }, calls);

    const events = await collect(
      driverIn('permission', { policy }).run(makeRunInput({ agent: geminiAgent })),
    );

    expect(messageTexts(events).join('')).toContain('permission:allow-once');
    expect(calls).toEqual([{ tool: 'Write file', input: { path: 'a.txt' }, jobId: 'j1' }]);
  });

  it('rejects a permission request when the Régis policy says deny', async () => {
    const policy = policyReturning({ allow: false, message: 'Outil interdit par la politique : Write file' });

    const events = await collect(
      driverIn('permission', { policy }).run(makeRunInput({ agent: geminiAgent })),
    );

    expect(messageTexts(events).join('')).toContain('permission:reject-once');
    expect(messageTexts(events).join('')).not.toContain('allow-once');
  });

  it('waits for the approval when the Régis policy says ask, then answers', async () => {
    let release: (decision: ToolDecision) => void = () => undefined;
    let asked: () => void = () => undefined;
    const requested = new Promise<void>((resolveAsked) => {
      asked = resolveAsked;
    });
    const policy: AgentToolPolicy = {
      ...denyWritesPolicy,
      authorizeTool: () => {
        asked();
        return new Promise<ToolDecision>((resolveDecision) => {
          release = resolveDecision;
        });
      },
    };

    const running = collect(driverIn('permission', { policy }).run(makeRunInput({ agent: geminiAgent })));
    await requested;
    release({ allow: true });
    const events = await running;

    expect(messageTexts(events).join('')).toContain('permission:allow-once');
  });

  it('rejects when the approval is deferred or the policy fails', async () => {
    const policy: AgentToolPolicy = {
      ...denyWritesPolicy,
      authorizeTool: () => Promise.reject(new Error('store down')),
    };

    const events = await collect(
      driverIn('permission', { policy }).run(makeRunInput({ agent: geminiAgent })),
    );

    expect(messageTexts(events).join('')).toContain('permission:reject-once');
  });

  it('does not leak the parent environment to the agent process', async () => {
    process.env.REGIS_ACP_TEST_LEAK = 'leaked';
    try {
      const events = await collect(driverIn('env').run(makeRunInput({ agent: geminiAgent })));

      expect(messageTexts(events).join('')).toBe('leak:absent');
    } finally {
      delete process.env.REGIS_ACP_TEST_LEAK;
    }
  });

  it('refuses an unsupported protocol version', async () => {
    const events = await collect(driverIn('badversion').run(makeRunInput({ agent: geminiAgent })));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', message: expect.stringContaining('7') as unknown });
  });

  it('cancels the session on abort and ends as aborted', async () => {
    const controller = new AbortController();
    const events: AgentEvent[] = [];
    const input = makeRunInput({ agent: geminiAgent, signal: controller.signal });

    for await (const event of driverIn('hang').run(input)) {
      events.push(event);
      if (event.type === 'start') {
        controller.abort();
      }
    }

    expect(events.at(-1)).toEqual({ type: 'end', resultText: '', isError: true, subtype: 'aborted' });
  });

  it('reports a missing executable as unavailable', async () => {
    const driver = driverIn('simple', {
      resolveCommand: () => Promise.resolve({ command: 'definitely-not-a-real-binary-xyz', args: [] }),
    });

    await expect(collect(driver.run(makeRunInput({ agent: geminiAgent })))).rejects.toBeInstanceOf(
      DriverUnavailableError,
    );
  });

  it('resolves the stored secret without leaking it into events', async () => {
    const driver = driverIn('simple', {
      resolveSecret: (ref) => Promise.resolve(ref === 'ref-1' ? 'secret-value' : null),
    });

    const events = await collect(driver.run(makeRunInput({ agent: { ...geminiAgent, secretRef: 'ref-1' } })));

    expect(events.at(-1)).toMatchObject({ type: 'end', isError: false });
    expect(JSON.stringify(events)).not.toContain('secret-value');
  });

  it('tests the agent with a round trip', async () => {
    expect(await driverIn('simple').test(geminiAgent)).toMatchObject({ ok: true });
  });
});

describe('UpdateMapper', () => {
  it('starts a new message when the message id changes', () => {
    const mapper = new UpdateMapper();
    const text = (messageId: string, value: string) => ({
      sessionUpdate: 'agent_message_chunk',
      messageId,
      content: { type: 'text', text: value },
    });

    expect(mapper.push(text('a', 'one'))).toEqual([]);
    expect(mapper.push(text('b', 'two'))).toEqual([{ type: 'message', text: 'one' }]);
    expect(mapper.flush()).toEqual([{ type: 'message', text: 'two' }]);
  });

  it('ignores thoughts and unknown updates', () => {
    const mapper = new UpdateMapper();

    expect(mapper.push({ sessionUpdate: 'agent_thought_chunk' })).toEqual([]);
    expect(mapper.push({ sessionUpdate: 'usage_update' })).toEqual([]);
  });
});

describe('resolveGeminiCommand', () => {
  it('starts the CLI in ACP mode with a non-auto approval mode and the configured model', async () => {
    const { command, args } = await resolveGeminiCommand(
      { getSetting: () => Promise.resolve(null), env: { REGIS_GEMINI_BIN: process.execPath } },
      makeAgent({ runtime: 'gemini-cli', mode: 'acp', model: 'gemini-2.5-pro' }),
    );

    expect(command).toBe(process.execPath);
    expect(args).toEqual(['--acp', '--approval-mode', 'default', '--model', 'gemini-2.5-pro']);
  });

  it('fails when the executable cannot be found', async () => {
    await expect(
      resolveGeminiCommand(
        { getSetting: () => Promise.resolve(null), env: { PATH: '' } },
        makeAgent({ runtime: 'gemini-cli', mode: 'acp' }),
      ),
    ).rejects.toBeInstanceOf(DriverUnavailableError);
  });
});

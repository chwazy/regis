import { describe, expect, it } from 'vitest';
import { FIXTURE_CLAUDE_VERSION } from '../../agents/claude-bin';
import { createDriverRegistry } from '../../agents/registry';
import { makeAgent } from '../../agents/test-support';
import { createAgentsMethods } from './agents';

function methodsWith(settings: Record<string, string>, agents = [makeAgent()], env: NodeJS.ProcessEnv = {}) {
  const getSetting = (key: string): Promise<string | null> => Promise.resolve(settings[key] ?? null);
  const { getDriver } = createDriverRegistry({
    mcpHost: { listTools: () => [], callTool: () => Promise.resolve({}) },
    store: {
      listAgents: () => Promise.resolve(agents),
      listConnectors: () => Promise.resolve([]),
      getSetting,
    },
    resolveSecret: () => Promise.resolve(null),
    onLog: () => undefined,
    env: {},
  });
  return createAgentsMethods({ listAgents: () => Promise.resolve(agents), getSetting, getDriver, env });
}

describe('agents.test', () => {
  it('returns a readable message instead of throwing when claudeBin is invalid', async () => {
    const methods = methodsWith({ 'agents.claudeBin': 'no-such-claude' });

    const result = await methods['agents.test']?.({ agentId: 'a1' });

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('introuvable') as unknown });
  });

  it('rejects an unknown agent id', async () => {
    const methods = methodsWith({});

    await expect(methods['agents.test']?.({ agentId: 'missing' })).rejects.toThrow('Agent inconnu');
  });

  it('reports planned runtimes as unavailable', async () => {
    const methods = methodsWith({}, [makeAgent({ runtime: 'codex-cli' })]);

    const result = await methods['agents.test']?.({ agentId: 'a1' });

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('prévu') as unknown });
  });
});

describe('agents.detect', () => {
  it('returns an empty result when nothing is installed', async () => {
    const methods = methodsWith({ 'ollama.url': 'http://127.0.0.1:1' });

    expect(await methods['agents.detect']?.({})).toEqual({});
  });

  it('reports Claude as simulated in demo mode even when the fake CLI cannot run', async () => {
    const methods = methodsWith({ 'ollama.url': 'http://127.0.0.1:1' }, [makeAgent()], {
      REGIS_DEMO: '1',
      REGIS_CLAUDE_BIN: 'no-such-claude',
    });

    expect(await methods['agents.detect']?.({})).toEqual({
      claude: { path: 'no-such-claude', version: FIXTURE_CLAUDE_VERSION, simulated: true },
    });
  });

  it('does not flag Claude as simulated outside demo mode', async () => {
    const methods = methodsWith({ 'ollama.url': 'http://127.0.0.1:1', 'agents.claudeBin': 'nope' });

    expect(await methods['agents.detect']?.({})).toEqual({});
  });
});

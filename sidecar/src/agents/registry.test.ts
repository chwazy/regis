import { describe, expect, it } from 'vitest';
import { DriverUnavailableError } from './driver';
import { createDriverRegistry, type AgentRegistryDeps } from './registry';
import { makeAgent } from './test-support';

function deps(overrides: Partial<AgentRegistryDeps> = {}): AgentRegistryDeps {
  return {
    mcpHost: { listTools: () => [], callTool: () => Promise.resolve(undefined) },
    store: {
      listAgents: () => Promise.resolve([]),
      listConnectors: () => Promise.resolve([]),
      getSetting: () => Promise.resolve(null),
    },
    resolveSecret: () => Promise.resolve(null),
    onLog: () => undefined,
    ...overrides,
  };
}

const geminiAgent = makeAgent({ runtime: 'gemini-cli', mode: 'acp' });

describe('createDriverRegistry', () => {
  it('keeps the Gemini ACP driver disabled by default', () => {
    expect(() => createDriverRegistry(deps()).getDriver(geminiAgent)).toThrow(DriverUnavailableError);
  });

  it('returns the ACP driver once enabled and only for the acp mode', () => {
    const registry = createDriverRegistry(deps({ acpEnabled: true }));

    expect(registry.getDriver(geminiAgent).runtime).toBe('gemini-cli');
    expect(() =>
      createDriverRegistry(deps({ acpEnabled: true })).getDriver({ ...geminiAgent, mode: 'headless' }),
    ).toThrow(DriverUnavailableError);
  });
});

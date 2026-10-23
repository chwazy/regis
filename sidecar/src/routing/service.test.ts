import { describe, expect, it } from 'vitest';
import type { RoutingRule } from '@regis/shared';
import type { AgentDriver } from '../agents/driver';
import { makeAgent } from '../agents/test-support';
import { NoEligibleAgentError } from './engine';
import { createRoutingService } from './service';

const ollama = makeAgent({ id: 'ollama', runtime: 'ollama', isLocalOnly: true });
const claude = makeAgent({ id: 'claude' });

function service(rules: RoutingRule[], reply: string, agents = [ollama, claude]) {
  const router: AgentDriver = {
    runtime: 'ollama',
    run: async function* () {
      await Promise.resolve();
      yield { type: 'end', resultText: reply, isError: false };
    },
    test: () => Promise.resolve({ ok: true, latencyMs: 0, costUsd: 0 }),
  };
  return createRoutingService({
    listEntities: () => Promise.resolve([]),
    listLinks: () => Promise.resolve([]),
    listJobs: () => Promise.resolve([]),
    listAgents: () => Promise.resolve(agents),
    listRules: () => Promise.resolve(rules),
    getSetting: () => Promise.resolve(null),
    getDriver: () => router,
    getDataDir: () => Promise.resolve('data'),
  });
}

const rule = (conditionsJson: unknown, agentId: string): RoutingRule => ({
  id: 'r1',
  ord: 0,
  conditionsJson,
  agentId,
  reason: 'test',
  enabled: true,
});

describe('routing service', () => {
  it('uses the matching rule before asking the router', async () => {
    const decision = await service([rule({ taskType: 'other' }, 'claude')], '{}').decide({ task: 't' });

    expect(decision).toMatchObject({ agentId: 'claude', ruleId: 'r1', viaFallback: false });
  });

  it('asks the router when no rule matches', async () => {
    const decision = await service([], '{"agentId":"claude","reason":"code"}').decide({ task: 't' });

    expect(decision).toMatchObject({ agentId: 'claude', viaFallback: true, reason: 'code' });
  });

  it('refuses when only remote agents exist and a local-only rule applies', async () => {
    await expect(
      service([rule({ requireLocal: true }, 'claude')], '{}', [claude]).decide({ task: 't' }),
    ).rejects.toBeInstanceOf(NoEligibleAgentError);
  });
});

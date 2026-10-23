import { describe, expect, it } from 'vitest';
import type { AgentDriver, AgentEvent } from '../agents/driver';
import { makeAgent } from '../agents/test-support';
import { NoEligibleAgentError, type RoutingContext } from './engine';
import { fallbackRoute } from './fallback';

const ctx: RoutingContext = {
  clientIds: [],
  projectIds: [],
  entityTags: [],
  taskType: 'other',
  now: new Date('2026-03-04T11:00:00Z'),
  budgetRemainingPct: {},
};

function mockRouter(events: AgentEvent[], prompts: string[] = []): AgentDriver {
  return {
    runtime: 'ollama',
    run: async function* (input) {
      await Promise.resolve();
      prompts.push(input.prompt);
      yield* events;
    },
    test: () => Promise.resolve({ ok: true, latencyMs: 0, costUsd: 0 }),
  };
}

const answer = (text: string): AgentEvent[] => [{ type: 'end', resultText: text, isError: false }];

const remote = makeAgent({ id: 'x', useWhen: 'rédaction' });
const local = makeAgent({ id: 'local', runtime: 'ollama', isLocalOnly: true, useWhen: 'tri de mails' });

describe('fallbackRoute', () => {
  it('returns the agent chosen by the router when it is eligible', async () => {
    const prompts: string[] = [];
    const router = mockRouter(answer('{"agentId":"x","reason":"y"}'), prompts);

    const decision = await fallbackRoute('écrire un devis', ctx, [remote, local], router);

    expect(decision).toEqual({ agentId: 'x', ruleId: null, reason: 'y', viaFallback: true });
    expect(prompts[0]).toContain('écrire un devis');
    expect(prompts[0]).toContain('rédaction');
  });

  it('falls back to the default agent when the router invents an agent', async () => {
    const router = mockRouter(answer('{"agentId":"ghost","reason":"y"}'));

    const decision = await fallbackRoute('t', ctx, [remote, local], router, { defaultAgentId: 'local' });

    expect(decision).toMatchObject({ agentId: 'local', viaFallback: true });
    expect(decision.reason).toContain('ghost');
  });

  it('falls back to the default agent on unreadable answers and failures', async () => {
    const garbled = await fallbackRoute('t', ctx, [remote], mockRouter(answer('no json here')));
    const failed = await fallbackRoute('t', ctx, [remote], mockRouter([{ type: 'error', message: 'boom' }]));

    expect(garbled).toMatchObject({ agentId: 'x', viaFallback: true });
    expect(failed.reason).toContain('boom');
  });

  it('never returns a non-local agent when requireLocal is set', async () => {
    const router = mockRouter(answer('{"agentId":"x","reason":"y"}'));

    const decision = await fallbackRoute('t', ctx, [remote, local], router, { requireLocal: true });

    expect(decision.agentId).toBe('local');
  });

  it('throws when requireLocal is set and no local agent is active', async () => {
    const router = mockRouter(answer('{"agentId":"x","reason":"y"}'));

    await expect(fallbackRoute('t', ctx, [remote], router, { requireLocal: true })).rejects.toBeInstanceOf(
      NoEligibleAgentError,
    );
    await expect(
      fallbackRoute('t', ctx, [{ ...local, enabled: false }], router, { requireLocal: true }),
    ).rejects.toBeInstanceOf(NoEligibleAgentError);
  });
});

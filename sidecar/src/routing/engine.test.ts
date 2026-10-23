import { describe, expect, it } from 'vitest';
import type { RoutingRule } from '@regis/shared';
import { makeAgent } from '../agents/test-support';
import {
  NoEligibleAgentError,
  matchRule,
  requiresLocal,
  route,
  type RoutingConditions,
  type RoutingContext,
} from './engine';

const ollama = makeAgent({ id: 'ollama', runtime: 'ollama', isLocalOnly: true });
const claude = makeAgent({ id: 'claude' });
const api = makeAgent({ id: 'api', runtime: 'anthropic-api', budgetDailyUsd: 10 });
const agents = [ollama, claude, api];

function rule(
  id: string,
  ord: number,
  conditions: RoutingConditions,
  agentId: string,
  enabled = true,
): RoutingRule {
  return { id, ord, conditionsJson: conditions, agentId, reason: `raison ${id}`, enabled };
}

function context(overrides: Partial<RoutingContext> = {}): RoutingContext {
  return {
    clientIds: [],
    projectIds: [],
    entityTags: [],
    taskType: 'other',
    now: new Date('2026-03-04T11:00:00Z'),
    timezone: 'Europe/Zurich',
    budgetRemainingPct: {},
    ...overrides,
  };
}

const rules = [
  rule('r1', 0, { client: 'venoge', requireLocal: true }, 'ollama'),
  rule('r3', 1, { client: 'rhone', taskType: 'redaction' }, 'claude'),
  rule('r4', 2, { client: 'venoge' }, 'claude'),
  rule('r5', 3, { client: 'rhone' }, 'api'),
];

describe('route', () => {
  it('returns the matching rule for a client and task type', () => {
    const decision = route(context({ clientIds: ['rhone'], taskType: 'redaction' }), rules, agents);

    expect(decision).toMatchObject({ agentId: 'claude', ruleId: 'r3', viaFallback: false });
  });

  it('keeps the local agent for a local-only client even if a lower rule matches', () => {
    const decision = route(context({ clientIds: ['venoge'] }), rules, agents);

    expect(decision).toMatchObject({ agentId: 'ollama', ruleId: 'r1' });
  });

  it('never selects a disabled rule', () => {
    const disabled = [rule('r1', 0, {}, 'claude', false), rule('r2', 1, {}, 'api')];

    expect(route(context(), disabled, agents)?.ruleId).toBe('r2');
  });

  it('returns null when no rule matches', () => {
    expect(route(context({ clientIds: ['other'] }), rules, agents)).toBeNull();
  });

  it('skips a matching rule whose agent is disabled', () => {
    const pair = [rule('r1', 0, {}, 'claude'), rule('r2', 1, {}, 'api')];
    const withDisabled = [makeAgent({ id: 'claude', enabled: false }), api];

    expect(route(context(), pair, withDisabled)?.ruleId).toBe('r2');
  });

  it('substitutes a local agent when a local-only rule targets a remote agent', () => {
    const decision = route(context(), [rule('r1', 0, { requireLocal: true }, 'claude')], agents);

    expect(decision).toMatchObject({ agentId: 'ollama', ruleId: 'r1' });
  });

  it('throws when a local-only rule matches and no local agent is active', () => {
    const localRule = [rule('r1', 0, { requireLocal: true }, 'claude')];

    expect(() => route(context(), localRule, [claude, api])).toThrow(NoEligibleAgentError);
    expect(() => route(context(), localRule, [{ ...ollama, enabled: false }, claude])).toThrow(
      NoEligibleAgentError,
    );
  });
});

describe('matchRule', () => {
  it('combines conditions with AND', () => {
    const conditions: RoutingConditions = { client: 'rhone', taskType: 'redaction' };

    expect(matchRule(conditions, context({ clientIds: ['rhone'], taskType: 'redaction' }))).toBe(true);
    expect(matchRule(conditions, context({ clientIds: ['rhone'], taskType: 'code' }))).toBe(false);
    expect(matchRule(conditions, context({ taskType: 'redaction' }))).toBe(false);
  });

  it('matches project, tag and source', () => {
    const ctx = context({ projectIds: ['p1'], entityTags: ['NDA'], source: 'mail' });

    expect(matchRule({ project: 'p1', entityTag: 'nda', source: 'mail' }, ctx)).toBe(true);
    expect(matchRule({ project: 'p2' }, ctx)).toBe(false);
    expect(matchRule({ entityTag: 'vip' }, ctx)).toBe(false);
    expect(matchRule({ source: 'chat' }, ctx)).toBe(false);
  });

  it('matches budgetRemainingPctBelow only under the threshold', () => {
    const conditions: RoutingConditions = { budgetRemainingPctBelow: 20 };

    expect(matchRule(conditions, context({ budgetRemainingPct: { api: 15 } }))).toBe(true);
    expect(matchRule(conditions, context({ budgetRemainingPct: { api: 25 } }))).toBe(false);
    expect(matchRule(conditions, context())).toBe(false);
  });

  it('handles a time window crossing midnight in the app timezone', () => {
    const conditions: RoutingConditions = { timeWindow: { from: '22:00', to: '06:00' } };
    const at = (iso: string) => context({ now: new Date(iso) });

    expect(matchRule(conditions, at('2026-03-04T22:30:00Z'))).toBe(true);
    expect(matchRule(conditions, at('2026-03-05T04:00:00Z'))).toBe(true);
    expect(matchRule(conditions, at('2026-03-04T11:00:00Z'))).toBe(false);
  });

  it('handles a same-day time window and weekdays', () => {
    const conditions: RoutingConditions = { timeWindow: { from: '08:00', to: '12:00', days: [1] } };

    expect(matchRule(conditions, context({ now: new Date('2026-03-02T08:30:00Z') }))).toBe(true);
    expect(matchRule(conditions, context({ now: new Date('2026-03-03T08:30:00Z') }))).toBe(false);
    expect(matchRule(conditions, context({ now: new Date('2026-03-02T12:30:00Z') }))).toBe(false);
  });

  it('attributes the after-midnight part of a window to the day it started', () => {
    const conditions: RoutingConditions = { timeWindow: { from: '22:00', to: '06:00', days: [1] } };

    expect(matchRule(conditions, context({ now: new Date('2026-03-03T03:00:00Z') }))).toBe(true);
    expect(matchRule(conditions, context({ now: new Date('2026-03-02T03:00:00Z') }))).toBe(false);
  });
});

describe('requiresLocal', () => {
  it('is true only when an enabled matching rule requires it', () => {
    const disabledLocal = [rule('r1', 0, { requireLocal: true }, 'ollama', false)];

    expect(requiresLocal(context({ clientIds: ['venoge'] }), rules)).toBe(true);
    expect(requiresLocal(context({ clientIds: ['rhone'] }), rules)).toBe(false);
    expect(requiresLocal(context(), disabledLocal)).toBe(false);
  });
});

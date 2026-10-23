import { describe, expect, it } from 'vitest';
import type { RoutingRule } from '@regis/shared';
import {
  cleanConditions,
  conditionsOf,
  describeConditions,
  moveRule,
  newRule,
  withContiguousOrder,
} from './routing-rows';

const rule = (id: string, ord: number): RoutingRule => ({
  id,
  ord,
  conditionsJson: {},
  agentId: 'a',
  reason: '',
  enabled: true,
});

describe('routing rows', () => {
  it('moves a rule and renumbers ord from 0', () => {
    const moved = withContiguousOrder(moveRule([rule('r1', 0), rule('r2', 1), rule('r3', 2)], 2, 0));

    expect(moved.map((entry) => [entry.id, entry.ord])).toEqual([
      ['r3', 0],
      ['r1', 1],
      ['r2', 2],
    ]);
  });

  it('ignores out-of-range moves', () => {
    const rules = [rule('r1', 0)];

    expect(moveRule(rules, 0, 3)).toBe(rules);
  });

  it('describes conditions with entity names and ANDs', () => {
    const text = describeConditions(
      { client: 'c1', taskType: 'redaction', budgetRemainingPctBelow: 20 },
      { c1: 'Atelier Rhône' },
    );

    expect(text).toBe('client = Atelier Rhône ET tâche = Rédaction ET budget restant < 20 %');
    expect(describeConditions({}, {})).toBe('toute tâche');
  });

  it('drops empty fields when cleaning conditions', () => {
    expect(
      cleanConditions({
        client: ' ',
        entityTag: ' nda ',
        timeWindow: { from: '22:00', to: '06:00', days: [] },
        requireLocal: false,
      }),
    ).toEqual({ entityTag: 'nda', timeWindow: { from: '22:00', to: '06:00' } });
  });

  it('reads malformed stored conditions as empty', () => {
    expect(conditionsOf({ ...rule('r', 0), conditionsJson: null })).toEqual({});
  });

  it('creates a new rule targeting the first enabled agent', () => {
    const agents = [
      { id: 'off', enabled: false },
      { id: 'on', enabled: true },
    ] as Parameters<typeof newRule>[0];

    expect(newRule(agents).agentId).toBe('on');
  });
});

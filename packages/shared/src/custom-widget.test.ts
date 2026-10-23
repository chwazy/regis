import { describe, expect, it } from 'vitest';
import { CustomWidgetSpec, customSpecFieldErrors, customWithinDayOffsets } from './custom-widget';

function specWith(filters: unknown[]): CustomWidgetSpec {
  return CustomWidgetSpec.parse({
    title: 'Test',
    itemKind: 'invoice',
    filters,
    aggregate: { fn: 'count' },
    render: 'kv',
  });
}

function errorsFor(field: string, op: string, value: unknown): string[] {
  return customSpecFieldErrors(specWith([{ field, op, value }]));
}

describe('customSpecFieldErrors', () => {
  it('accepts within_days on a date field with a number', () => {
    expect(errorsFor('data.dueDate', 'within_days', 7)).toEqual([]);
    expect(errorsFor('occurredAt', 'within_days', -30)).toEqual([]);
  });

  it('rejects within_days on a non-date field', () => {
    const errors = errorsFor('title', 'within_days', 7);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('champ date');
  });

  it('rejects within_days with a non-number or out-of-range value', () => {
    expect(errorsFor('occurredAt', 'within_days', '7')).toHaveLength(1);
    expect(errorsFor('occurredAt', 'within_days', true)).toHaveLength(1);
    expect(errorsFor('occurredAt', 'within_days', 100000)).toHaveLength(1);
  });

  it('rejects contains with a boolean but accepts text and numbers like the Rust side', () => {
    expect(errorsFor('title', 'contains', true)).toHaveLength(1);
    expect(errorsFor('title', 'contains', 'a')).toEqual([]);
    expect(errorsFor('title', 'contains', 3)).toEqual([]);
  });

  it('still reports unknown fields', () => {
    expect(errorsFor('nope', 'eq', 'a')).toEqual(['Champ inconnu : nope']);
  });
});

describe('customWithinDayOffsets', () => {
  it('lists the day boundaries needed by each within_days filter', () => {
    const offsets = customWithinDayOffsets(
      specWith([
        { field: 'occurredAt', op: 'within_days', value: 7 },
        { field: 'updatedAt', op: 'within_days', value: -3 },
        { field: 'title', op: 'eq', value: 'a' },
      ]).filters,
    );

    expect([...offsets].sort((a, b) => a - b)).toEqual([-3, 0, 1, 8]);
  });
});

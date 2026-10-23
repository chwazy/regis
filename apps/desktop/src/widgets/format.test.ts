import { describe, expect, it } from 'vitest';
import {
  calendarDayIn,
  localMidnightUtc,
  localWindows,
  fileName,
  formatAmount,
  parseToolArgs,
  toKeyValueRows,
} from './format';

describe('toKeyValueRows', () => {
  it('lists the fields of a JSON object returned as text', () => {
    const result = { content: [{ type: 'text', text: '{"open":3,"owner":"Dylan","due":null}' }] };

    expect(toKeyValueRows(result)).toEqual([
      { key: 'open', value: '3' },
      { key: 'owner', value: 'Dylan' },
      { key: 'due', value: '—' },
    ]);
  });

  it('prefers structured content and numbers array entries', () => {
    expect(toKeyValueRows({ structuredContent: ['a', { b: 1 }] })).toEqual([
      { key: '1', value: 'a' },
      { key: '2', value: '{"b":1}' },
    ]);
  });

  it('shows plain text as a single result', () => {
    expect(toKeyValueRows({ content: [{ type: 'text', text: 'all good' }] })).toEqual([
      { key: 'Résultat', value: 'all good' },
    ]);
  });

  it('throws the tool message when the tool reports an error', () => {
    expect(() => toKeyValueRows({ isError: true, content: [{ type: 'text', text: 'boom' }] })).toThrow(
      'boom',
    );
  });

  it('caps the number of rows', () => {
    const big = Object.fromEntries(Array.from({ length: 50 }, (_, index) => [`k${String(index)}`, index]));

    expect(toKeyValueRows({ structuredContent: big })).toHaveLength(20);
  });
});

describe('parseToolArgs', () => {
  it('accepts empty text and JSON objects only', () => {
    expect(parseToolArgs('  ')).toEqual({ ok: true, value: {} });
    expect(parseToolArgs('{"days":7}')).toEqual({ ok: true, value: { days: 7 } });
    expect(parseToolArgs('[1]').ok).toBe(false);
    expect(parseToolArgs('{oops').ok).toBe(false);
  });
});

describe('formatters', () => {
  it('computes the calendar day in the given timezone', () => {
    expect(calendarDayIn(new Date('2026-10-21T23:30:00.000Z'), 'Europe/Zurich')).toBe('2026-10-22');
  });

  it('keeps the file name of a relative path', () => {
    expect(fileName('offers/2026/Offre.docx')).toBe('Offre.docx');
    expect(fileName('Offre.docx')).toBe('Offre.docx');
  });

  it('prefixes amounts with their currency', () => {
    expect(formatAmount(0, null)).toBe('0');
    expect(formatAmount(0, 'CHF')).toBe('CHF 0');
  });
});

describe('local day windows', () => {
  it('maps a local day to its UTC bounds in summer and winter time', () => {
    expect(localMidnightUtc('2026-10-22', 'Europe/Zurich')).toBe('2026-10-21T22:00:00.000Z');
    expect(localMidnightUtc('2026-12-15', 'Europe/Zurich')).toBe('2026-12-14T23:00:00.000Z');
  });

  it('follows the DST change inside the 7-day window', () => {
    const windows = localWindows('2026-10-22', 'Europe/Zurich');
    expect(windows.dayStart).toBe('2026-10-21T22:00:00.000Z');
    expect(windows.dayEnd).toBe('2026-10-22T22:00:00.000Z');
    expect(windows.agendaEnd).toBe('2026-10-28T23:00:00.000Z');
    expect(windows.monthStart).toBe('2026-09-30T22:00:00.000Z');
    expect(windows.monthEnd).toBe('2026-10-31T23:00:00.000Z');
  });

  it('rolls the month over at year end', () => {
    expect(localWindows('2026-12-31', 'Europe/Zurich').monthEnd).toBe('2026-12-31T23:00:00.000Z');
  });
});

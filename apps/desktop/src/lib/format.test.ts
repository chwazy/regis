import { describe, expect, it } from 'vitest';
import {
  errorMessage,
  formatCalendarDay,
  formatClock,
  formatDay,
  formatElapsed,
  formatHours,
  formatTokens,
  formatUsd,
} from './format';

const TZ = 'Europe/Zurich';

describe('shared formats', () => {
  it('formats times in the app timezone, not the system one', () => {
    expect(formatClock('2026-10-22T12:05:00.000Z', TZ)).toBe('14:05');
    expect(formatClock('2026-10-22T12:05:00.000Z', 'UTC')).toBe('12:05');
    expect(formatClock(null, TZ)).toBe('—');
  });

  it('formats days and calendar days the same way', () => {
    expect(formatDay('2026-10-21T22:30:00.000Z', TZ)).toBe(formatCalendarDay('2026-10-22'));
    expect(formatCalendarDay('pas une date')).toBe('pas une date');
  });

  it('formats estimated amounts in USD', () => {
    expect(formatUsd(0)).toBe('0 USD');
    expect(formatUsd(0.123)).toBe('≈ 0.12 USD');
    expect(formatUsd(0.0012)).toBe('≈ 0.0012 USD');
    expect(formatUsd(5, { estimate: false })).toBe('5.00 USD');
  });

  it('formats elapsed time, hours and tokens', () => {
    const start = '2026-10-22T08:00:00.000Z';
    expect(formatElapsed(start, '2026-10-22T09:05:00.000Z', 0)).toBe('1 h 05');
    expect(formatElapsed(null, null, 0)).toBe('—');
    expect(formatHours(7.5)).toBe('7h30');
    expect(formatTokens(12_345)).toBe('12.3k');
  });

  it('extracts readable error messages', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage({ message: 'ipc' })).toBe('ipc');
    expect(errorMessage('raw')).toBe('raw');
  });
});

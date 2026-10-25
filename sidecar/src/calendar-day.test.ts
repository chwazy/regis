import { afterEach, describe, expect, it, vi } from 'vitest';
import { calendarDay } from './calendar-day';

describe('calendarDay', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the calendar day in the given time zone', () => {
    expect(calendarDay(new Date('2026-03-04T23:30:00Z'), 'Europe/Zurich')).toBe('2026-03-05');
    expect(calendarDay(new Date('2026-03-04T23:30:00Z'), 'UTC')).toBe('2026-03-04');
  });

  it('keeps the YYYY-MM-DD shape when only English ICU data is available', () => {
    class EnglishOnly extends Intl.DateTimeFormat {
      constructor(_locales?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions) {
        super('en-US', options);
      }
    }
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(EnglishOnly);
    expect(calendarDay(new Date('2026-10-25T08:00:00Z'), 'Europe/Zurich')).toBe('2026-10-25');
  });
});

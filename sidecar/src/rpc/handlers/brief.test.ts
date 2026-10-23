import { describe, expect, it } from 'vitest';
import type { Brief, BriefData } from '@regis/shared';
import { createBriefMethods, localClock } from './brief';

const NOW = new Date('2026-10-22T05:45:00.000Z');

const BRIEF: Brief = {
  id: 'b1',
  date: '2026-10-22',
  generatedAt: NOW.toISOString(),
  jobId: null,
  headline: 'x',
  sectionsJson: {},
};

function methods(settings: Record<string, string> = {}) {
  const calls: { generate: { force?: boolean }[]; get: string[] } = { generate: [], get: [] };
  const handlers = createBriefMethods({
    generate: (_now, opts) => {
      calls.generate.push(opts ?? {});
      return Promise.resolve(BRIEF);
    },
    getBrief: (date) => {
      calls.get.push(date);
      return Promise.resolve(null);
    },
    collect: () => Promise.resolve({ date: '2026-10-22' } as BriefData),
    getSetting: (key) => Promise.resolve(settings[key] ?? null),
    now: () => NOW,
  });
  return { handlers, calls };
}

describe('localClock', () => {
  it('returns the calendar day and minutes in the app timezone', () => {
    expect(localClock(NOW, 'Europe/Zurich')).toEqual({ date: '2026-10-22', minutes: 7 * 60 + 45 });
    expect(localClock(new Date('2026-10-21T23:30:00.000Z'), 'Europe/Zurich')).toEqual({
      date: '2026-10-22',
      minutes: 90,
    });
  });
});

describe('brief methods', () => {
  it('forwards the force flag to the generator', async () => {
    const { handlers, calls } = methods();

    await handlers['brief.generate']?.({ force: true });
    await handlers['brief.generate']?.({});

    expect(calls.generate).toEqual([{ force: true }, {}]);
  });

  it('reads the brief of today in the app timezone by default', async () => {
    const { handlers, calls } = methods({ 'app.timezone': 'Pacific/Auckland' });

    await handlers['brief.get']?.({});
    await handlers['brief.get']?.({ date: '2026-01-02' });

    expect(calls.get).toEqual(['2026-10-22', '2026-01-02']);
  });

  it('rejects a malformed date', async () => {
    const { handlers } = methods();

    await expect(handlers['brief.get']?.({ date: 'today' })).rejects.toThrow();
  });

  it('exposes the collected data and the local clock', async () => {
    const { handlers } = methods();

    expect(await handlers['brief.data']?.({})).toEqual({ date: '2026-10-22' });
    expect(await handlers['brief.clock']?.({})).toEqual({ date: '2026-10-22', minutes: 7 * 60 + 45 });
  });
});

import { describe, expect, it } from 'vitest';
import { minutesTemplateValues, renderMinutes, type MinutesMeta } from './render';
import type { MinutesDraft } from './schema';

const draft: MinutesDraft = {
  summary: 'Résumé généré.',
  decisions: ['Décision A'],
  actions: [
    { task: 'Faire X', owner: 'Alice' },
    { task: 'Faire Y', owner: null },
  ],
  openPoints: [],
};

const meta: MinutesMeta = {
  title: 'Point client',
  startedAt: '2026-10-22T08:00:00Z',
  durationMs: 65 * 60_000,
  attendees: [
    { name: 'Alice Martin', address: 'alice@example.com' },
    { name: null, address: 'bob@example.com' },
  ],
  agentName: 'Agent test',
  timezone: 'Europe/Zurich',
};

describe('renderMinutes header', () => {
  it('converts the start into the timezone and formats duration and attendees', () => {
    const text = renderMinutes(draft, meta);
    expect(text).toContain('22.10.2026');
    expect(text).toContain('10:00');
    expect(text).toContain('1 h 05');
    expect(text).toContain('Alice Martin, bob@example.com');
  });

  it('omits the duration line when durationMs is null', () => {
    expect(renderMinutes(draft, { ...meta, durationMs: null })).not.toContain('Durée');
  });

  it('contains no value from the draft above the first section', () => {
    const text = renderMinutes(draft, meta);
    const header = text.slice(0, text.indexOf('## Résumé'));
    for (const value of [draft.summary, 'Décision A', 'Faire X', 'Alice', 'Faire Y']) {
      expect(header.replace('Alice Martin', '')).not.toContain(value);
    }
  });
});

describe('renderMinutes body', () => {
  it('has the four sections and shows Aucun(e) for an empty one', () => {
    const text = renderMinutes(draft, meta);
    for (const title of ['## Résumé', '## Décisions', '## Actions', '## Points ouverts']) {
      expect(text).toContain(title);
    }
    expect(text.slice(text.indexOf('## Points ouverts'))).toContain('Aucun(e)');
  });

  it('never writes a counter derived from the draft', () => {
    expect(renderMinutes(draft, meta)).not.toMatch(/\d+\s+(actions?|décisions?|points?)/i);
  });
});

describe('minutesTemplateValues', () => {
  it('returns exactly the nine pv.* keys', () => {
    expect(Object.keys(minutesTemplateValues(draft, meta)).sort()).toEqual(
      [
        'pv.titre',
        'pv.date',
        'pv.heure',
        'pv.duree',
        'pv.participants',
        'pv.resume',
        'pv.decisions',
        'pv.actions',
        'pv.points',
      ].sort(),
    );
  });
});

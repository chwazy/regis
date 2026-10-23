import { describe, expect, it } from 'vitest';
import { makeEvent, makeLink, makeProject, makeTimeEntry } from './test-support';
import { suggestHours } from './suggest-hours';

const NOW = new Date('2026-10-22T13:00:00.000Z');
const project = makeProject(42, 'Ligne 3');

describe('suggestHours', () => {
  it('suggests one hour for a finished linked event without hours that day', () => {
    const event = makeEvent('2026-10-22T08:30:00.000Z', '2026-10-22T09:30:00.000Z', { title: 'Réunion' });

    const result = suggestHours([event], [], [project], [makeLink(event.id, project.id)], NOW);

    expect(result).toEqual([
      {
        eventItemId: event.id,
        projectExternalId: 42,
        projectName: 'Ligne 3',
        date: '2026-10-22',
        hours: 1,
        description: 'Réunion',
      },
    ]);
  });

  it('links an event to a project by its title', () => {
    const event = makeEvent('2026-10-22T08:30:00.000Z', '2026-10-22T09:00:00.000Z', {
      title: 'Point ligne 3 avec le client',
    });

    const result = suggestHours([event], [], [project], [], NOW);

    expect(result.map((suggestion) => [suggestion.projectExternalId, suggestion.hours])).toEqual([[42, 0.5]]);
  });

  it('makes no suggestion when hours already exist that day on the project', () => {
    const event = makeEvent('2026-10-22T08:30:00.000Z', '2026-10-22T09:30:00.000Z');
    const entry = makeTimeEntry('2026-10-22', 2, { id: 42, name: 'Ligne 3' });

    expect(suggestHours([event], [entry], [project], [makeLink(event.id, project.id)], NOW)).toEqual([]);
  });

  it('keeps suggesting when the existing hours are on another day or project', () => {
    const event = makeEvent('2026-10-22T08:30:00.000Z', '2026-10-22T09:30:00.000Z');
    const entries = [
      makeTimeEntry('2026-10-21', 2, { id: 42, name: 'Ligne 3' }),
      makeTimeEntry('2026-10-22', 2, { id: 7, name: 'Autre' }),
    ];

    expect(suggestHours([event], entries, [project], [makeLink(event.id, project.id)], NOW)).toHaveLength(1);
  });

  it('ignores an event that is not finished yet', () => {
    const event = makeEvent('2026-10-22T12:30:00.000Z', '2026-10-22T13:30:00.000Z');

    expect(suggestHours([event], [], [project], [makeLink(event.id, project.id)], NOW)).toEqual([]);
  });

  it('ignores an event without a project and an event of another day', () => {
    const unlinked = makeEvent('2026-10-22T08:30:00.000Z', '2026-10-22T09:30:00.000Z', { title: 'Café' });
    const yesterday = makeEvent('2026-10-21T08:30:00.000Z', '2026-10-21T09:30:00.000Z');

    expect(
      suggestHours([unlinked, yesterday], [], [project], [makeLink(yesterday.id, project.id)], NOW),
    ).toEqual([]);
  });

  it('computes the day in the app timezone', () => {
    const lateEvent = makeEvent('2026-10-21T22:30:00.000Z', '2026-10-21T23:30:00.000Z');
    const afterMidnightLocal = new Date('2026-10-22T05:00:00.000Z');

    const result = suggestHours(
      [lateEvent],
      [],
      [project],
      [makeLink(lateEvent.id, project.id)],
      afterMidnightLocal,
      'Europe/Zurich',
    );

    expect(result[0]?.date).toBe('2026-10-22');
  });
});

import { describe, expect, it } from 'vitest';
import type { EntityCard, EntitySummary, FactSource } from '@regis/shared';
import {
  FACT_STATUS_LABELS,
  KIND_GROUPS,
  allTags,
  groupEntities,
  relativeAge,
  settleSynthesisRequest,
  statChips,
  withTag,
  withoutTag,
  entityInitials,
  factSourceLabel,
  factSourceTarget,
  resolveSelection,
  timelineAnchor,
  timelineTarget,
} from './brain-view';

const source = (overrides: Partial<FactSource>): FactSource => ({
  kind: 'item',
  id: 'm1',
  label: 'Re: Offre',
  fileId: null,
  ...overrides,
});

describe('brain view helpers', () => {
  it('groups entities into four kinds, with Autres instead of suppliers', () => {
    const labels = KIND_GROUPS.map((group) => group.label);

    expect(labels).toEqual(['Clients', 'Projets', 'Contacts', 'Autres']);
    expect(labels).not.toContain('Documents');
    expect(labels).not.toContain('Modèles');
  });

  it('labels the three fact statuses', () => {
    expect(FACT_STATUS_LABELS).toEqual({
      confirmed: 'Confirmé',
      to_verify: 'À vérifier',
      inferred: 'Déduit',
    });
  });

  it('builds initials from the first two words', () => {
    expect(entityInitials('Atelier Rhône SA')).toBe('AR');
    expect(entityInitials('Laiterie')).toBe('LA');
  });

  it('describes where a fact comes from and where its source leads', () => {
    expect(factSourceLabel(source({}))).toBe('mail · Re: Offre');
    expect(factSourceTarget(source({}))).toEqual({ type: 'timeline', anchor: timelineAnchor('m1') });
    expect(factSourceTarget(source({ kind: 'job', id: 'J1', label: 'Extraction' }))).toEqual({
      type: 'job',
      path: '/jobs/J1',
    });
    expect(factSourceTarget(source({ kind: 'file', fileId: 'f1', label: 'cahier.pdf' }))?.type).toBe('file');
    expect(factSourceTarget(source({ kind: 'file', fileId: null }))).toBeNull();
    expect(factSourceLabel(source({ kind: 'note', label: 'note' }))).toBe('note');
  });

  it('links timeline rows to a screen only when one exists', () => {
    const notes = [
      { id: 'n1', at: null, text: 'Réunion', noteType: 'transcript', sourceId: null },
      { id: 'n2', at: null, text: 'PV', noteType: 'minutes', sourceId: 'n1' },
      { id: 'n3', at: null, text: 'Libre', noteType: null, sourceId: null },
    ];
    expect(timelineTarget({ id: 'n1', kind: 'note' }, notes)).toBe('/transcripts/n1');
    expect(timelineTarget({ id: 'n2', kind: 'note' }, notes)).toBe('/transcripts/n1?tab=minutes');
    expect(timelineTarget({ id: 'n3', kind: 'note' }, notes)).toBeNull();
    expect(timelineTarget({ id: 'm1', kind: 'message' }, notes)).toBeNull();
  });

  it('keeps the requested entity even when the list is filtered, otherwise opens the first one', () => {
    const summary = (id: string): EntitySummary => ({
      entity: { id, kind: 'client', name: id, tagsJson: [], dataJson: {}, createdAt: '', updatedAt: '' },
      meta: '',
    });
    const list = [summary('a'), summary('b')];

    expect(resolveSelection(list, 'b')).toBe('b');
    expect(resolveSelection(list, 'not-listed')).toBe('not-listed');
    expect(resolveSelection(list, null)).toBe('a');
    expect(resolveSelection([], null)).toBeNull();
  });

  it('groups by kind, filters by tag and lists tags once', () => {
    const summary = (id: string, kind: EntitySummary['entity']['kind'], tags: string[]): EntitySummary => ({
      entity: { id, kind, name: id, tagsJson: tags, dataJson: {}, createdAt: '', updatedAt: '' },
      meta: '',
    });
    const list = [
      summary('a', 'client', ['Maintenance']),
      summary('b', 'other', ['maintenance', 'fiduciaire']),
      summary('c', 'client', []),
    ];

    expect(groupEntities(list, null).map((group) => [group.kind, group.entities.length])).toEqual([
      ['client', 2],
      ['other', 1],
    ]);
    expect(
      groupEntities(list, 'MAINTENANCE').flatMap((group) => group.entities.map((e) => e.entity.id)),
    ).toEqual(['a', 'b']);
    expect(allTags(list)).toEqual(['fiduciaire', 'Maintenance']);
  });

  it('adds and removes tags without duplicates', () => {
    expect(withTag(['froid'], ' #Alarmes ')).toEqual(['froid', 'Alarmes']);
    expect(withTag(['froid'], 'FROID')).toEqual(['froid']);
    expect(withTag(['froid'], '  ')).toEqual(['froid']);
    expect(withoutTag(['froid', 'Alarmes'], 'alarmes')).toEqual(['froid']);
  });

  it('builds figure chips from the card data only', () => {
    const card = {
      projects: [{}, {}],
      stats: { hoursLast30Days: 6.5, lastMessageAt: '2026-10-21T10:00:00.000Z' },
    } as unknown as EntityCard;
    const empty = {
      projects: [],
      stats: { hoursLast30Days: 0, lastMessageAt: null },
    } as unknown as EntityCard;

    expect(statChips(card, 'Europe/Zurich')).toEqual([
      '2 projets',
      '6h30 sur 30 jours',
      expect.stringMatching(/^dernier mail 21 oct/),
    ]);
    expect(statChips(empty, 'Europe/Zurich')).toEqual([]);
  });

  it('describes the synthesis age', () => {
    const now = new Date('2026-10-22T12:00:00.000Z');
    expect(relativeAge('2026-10-22T11:59:30.000Z', now)).toBe('à l’instant');
    expect(relativeAge('2026-10-22T11:15:00.000Z', now)).toBe('il y a 45 min');
    expect(relativeAge('2026-10-22T07:00:00.000Z', now)).toBe('il y a 5 h');
    expect(relativeAge('2026-10-21T08:00:00.000Z', now)).toBe('hier');
    expect(relativeAge('2026-10-18T08:00:00.000Z', now)).toBe('il y a 4 jours');
  });

  it('keeps a synthesis request pending until the job ran or a new synthesis arrived', () => {
    const at = '2026-10-22T10:00:00.000Z';
    const cardWith = (generatedAt: string | null, running: boolean) =>
      ({
        entity: { id: 'E1' },
        synthesis: generatedAt === null ? null : { generatedAt },
        activeJobs: running ? [{ kind: 'synthesis' }] : [],
      }) as unknown as EntityCard;
    const request = { entityId: 'E1', baseline: at, seenRunning: false };

    expect(settleSynthesisRequest(request, cardWith(at, false))).toBe(request);
    expect(settleSynthesisRequest(request, cardWith(at, true))).toEqual({ ...request, seenRunning: true });
    expect(settleSynthesisRequest({ ...request, seenRunning: true }, cardWith(at, false))).toBeNull();
    expect(settleSynthesisRequest(request, cardWith('2026-10-22T11:00:00.000Z', false))).toBeNull();
    expect(settleSynthesisRequest(null, cardWith(at, false))).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import type { Entity, GlobalSearchResult } from '@regis/shared';
import { entityPath } from '../lib/paths';
import {
  groupedEntries,
  isPaletteShortcut,
  matchPages,
  moveSelection,
  pageSuggestions,
  paletteEntries,
  type PalettePage,
} from './palette-model';

const pages: PalettePage[] = [
  { label: 'Brief', to: '/', detail: 'Page' },
  { label: 'Agents', to: '/agents', detail: 'Page' },
  { label: 'Agents & routage', to: '/reglages/agents', detail: 'Réglages' },
  { label: 'Général', to: '/reglages', detail: 'Réglages' },
];

const atelier: Entity = {
  id: 'E1',
  kind: 'client',
  name: 'Atelier Rhône SA',
  tagsJson: [],
  dataJson: {},
  createdAt: '',
  updatedAt: '',
};

const result: GlobalSearchResult = {
  entities: [atelier],
  documents: [
    { fileId: 'f1', name: 'atelier-offre.pdf', snippet: 'offre atelier', entityId: 'E1' },
    { fileId: 'f2', name: 'libre.pdf', snippet: '', entityId: null },
  ],
  mails: [
    { itemId: 'm1', title: 'Atelier : visite', snippet: 'rdv', entityId: null },
    { itemId: 'm2', title: 'Re: Atelier', snippet: '', entityId: 'E1' },
  ],
  notes: [
    { itemId: 'n1', title: 'Point Atelier', noteType: 'transcript', snippet: 'devis' },
    { itemId: 'n2', title: 'Idée', noteType: 'note', snippet: '' },
  ],
};

describe('command palette model', () => {
  it('lists the entities first, then documents, mails and transcripts', () => {
    const sections = groupedEntries(paletteEntries(result));

    expect(sections.map((section) => section.group)).toEqual(['entities', 'documents', 'mails', 'notes']);
    expect(sections[0]?.entries[0]).toMatchObject({ label: 'Atelier Rhône SA', group: 'entities' });
  });

  it('opens the card of the entity when Enter is pressed on it', () => {
    const [first] = paletteEntries(result);

    expect(first?.path).toBe(entityPath('E1'));
    expect(entityPath('E 1')).toBe('/cerveau?entity=E%201');
  });

  it('shows the entity kind label, not the raw kind', () => {
    expect(paletteEntries(result)[0]?.detail).toBe('Client');
  });

  it('hides results without a destination', () => {
    const entries = paletteEntries(result);
    const path = (key: string) => entries.find((entry) => entry.key === key)?.path;

    expect(path('document-f1')).toBe(entityPath('E1'));
    expect(path('document-f2')).toBeUndefined();
    expect(path('mail-m1')).toBeUndefined();
    expect(path('mail-m2')).toBe(entityPath('E1'));
    expect(path('note-n1')).toBe('/transcripts/n1');
    expect(path('note-n2')).toBeUndefined();
  });

  it('matches pages by name, ignoring case and accents', () => {
    expect(matchPages(pages, 'agents').map((entry) => entry.path)).toEqual(['/agents', '/reglages/agents']);
    expect(matchPages(pages, 'GENERAL').map((entry) => entry.path)).toEqual(['/reglages']);
    expect(matchPages(pages, 'routage')).toHaveLength(1);
    expect(matchPages(pages, '  ')).toEqual([]);
  });

  it('suggests every page when the query is empty', () => {
    expect(pageSuggestions(pages)).toHaveLength(4);
    expect(pageSuggestions(pages)[0]).toMatchObject({ group: 'pages', path: '/' });
  });

  it('omits empty groups', () => {
    expect(
      groupedEntries(paletteEntries({ entities: [atelier], documents: [], mails: [], notes: [] })),
    ).toHaveLength(1);
    expect(groupedEntries([])).toEqual([]);
  });

  it('wraps the selection around the list', () => {
    expect(moveSelection(0, 1, 3)).toBe(1);
    expect(moveSelection(2, 1, 3)).toBe(0);
    expect(moveSelection(0, -1, 3)).toBe(2);
    expect(moveSelection(0, 1, 0)).toBe(0);
  });

  it('recognizes Ctrl K and Cmd K', () => {
    expect(isPaletteShortcut({ key: 'k', ctrlKey: true, metaKey: false })).toBe(true);
    expect(isPaletteShortcut({ key: 'K', ctrlKey: false, metaKey: true })).toBe(true);
    expect(isPaletteShortcut({ key: 'k', ctrlKey: false, metaKey: false })).toBe(false);
    expect(isPaletteShortcut({ key: 'j', ctrlKey: true, metaKey: false })).toBe(false);
  });
});

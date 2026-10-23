import type { GlobalSearchResult } from '@regis/shared';
import { entityPath, transcriptPath } from '../lib/paths';
import { KIND_LABELS } from '../screens/brain/brain-view';

export type PaletteGroup = 'pages' | 'entities' | 'documents' | 'mails' | 'notes';

export interface PaletteEntry {
  key: string;
  group: PaletteGroup;
  label: string;
  detail: string;
  path: string;
}

export interface PalettePage {
  label: string;
  to: string;
  detail: string;
}

export const GROUP_LABELS: Record<PaletteGroup, string> = {
  pages: 'Pages',
  entities: 'Entités',
  documents: 'Documents',
  mails: 'Mails',
  notes: 'Transcriptions',
};

export const OPEN_PALETTE_EVENT = 'regis:open-palette';

const TRANSCRIPT_NOTE_TYPE = 'transcript';

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function pageEntry(page: PalettePage): PaletteEntry {
  return { key: `page-${page.to}`, group: 'pages', label: page.label, detail: page.detail, path: page.to };
}

/** Pages proposées quand le champ est vide. */
export function pageSuggestions(pages: readonly PalettePage[]): PaletteEntry[] {
  return pages.map(pageEntry);
}

/** Pages dont le nom contient la saisie (sans tenir compte de la casse ni des accents). */
export function matchPages(pages: readonly PalettePage[], query: string): PaletteEntry[] {
  const needle = normalize(query);
  if (needle === '') {
    return [];
  }
  return pages.filter((page) => normalize(`${page.label} ${page.detail}`).includes(needle)).map(pageEntry);
}

/**
 * Résultats de recherche ouvrables. Un résultat sans destination (mail ou document sans entité,
 * note ordinaire) est omis : la palette ne propose que ce qui mène quelque part.
 */
export function paletteEntries(result: GlobalSearchResult): PaletteEntry[] {
  const entries: PaletteEntry[] = result.entities.map((entity) => ({
    key: `entity-${entity.id}`,
    group: 'entities',
    label: entity.name,
    detail: KIND_LABELS[entity.kind] ?? entity.kind,
    path: entityPath(entity.id),
  }));
  for (const document of result.documents) {
    if (document.entityId !== null) {
      entries.push({
        key: `document-${document.fileId}`,
        group: 'documents',
        label: document.name,
        detail: document.snippet,
        path: entityPath(document.entityId),
      });
    }
  }
  for (const mail of result.mails) {
    if (mail.entityId !== null) {
      entries.push({
        key: `mail-${mail.itemId}`,
        group: 'mails',
        label: mail.title,
        detail: mail.snippet,
        path: entityPath(mail.entityId),
      });
    }
  }
  for (const note of result.notes) {
    if (note.noteType === TRANSCRIPT_NOTE_TYPE) {
      entries.push({
        key: `note-${note.itemId}`,
        group: 'notes',
        label: note.title,
        detail: note.snippet,
        path: transcriptPath(note.itemId),
      });
    }
  }
  return entries;
}

export function groupedEntries(entries: PaletteEntry[]): { group: PaletteGroup; entries: PaletteEntry[] }[] {
  return (Object.keys(GROUP_LABELS) as PaletteGroup[])
    .map((group) => ({ group, entries: entries.filter((entry) => entry.group === group) }))
    .filter((section) => section.entries.length > 0);
}

export function moveSelection(current: number, delta: number, length: number): number {
  if (length === 0) {
    return 0;
  }
  return (((current + delta) % length) + length) % length;
}

export function isPaletteShortcut(event: { key: string; ctrlKey: boolean; metaKey: boolean }): boolean {
  return (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k';
}

import type {
  Entity,
  EntityCard,
  EntityKind,
  EntityNote,
  EntitySummary,
  FactSource,
  FactStatus,
  ResourceKind,
  TimelineEntry,
} from '@regis/shared';
import { formatDay, formatHours } from '../../lib/format';
import { jobPath, transcriptPath } from '../../lib/paths';

export const KIND_GROUPS: { kind: EntityKind; label: string }[] = [
  { kind: 'client', label: 'Clients' },
  { kind: 'project', label: 'Projets' },
  { kind: 'contact', label: 'Contacts' },
  { kind: 'other', label: 'Autres' },
];

export const KIND_LABELS: Record<EntityKind, string> = {
  client: 'Client',
  project: 'Projet',
  contact: 'Contact',
  other: 'Autre',
};

export const RESOURCE_KIND_LABELS: Record<ResourceKind, string> = {
  repo: 'Repo local',
  remote: 'Remote git',
  conventions: 'Conventions',
  specs: 'Specs',
  document: 'Document',
  link: 'Lien',
};

export interface EntityGroup {
  kind: EntityKind;
  label: string;
  entities: EntitySummary[];
}

export function entityTags(entity: Entity): string[] {
  return Array.isArray(entity.tagsJson)
    ? entity.tagsJson.filter((tag): tag is string => typeof tag === 'string' && tag.trim() !== '')
    : [];
}

function sameTag(left: string, right: string): boolean {
  return left.toLocaleLowerCase('fr') === right.toLocaleLowerCase('fr');
}

export function allTags(entities: EntitySummary[]): string[] {
  const tags: string[] = [];
  for (const { entity } of entities) {
    for (const tag of entityTags(entity)) {
      if (!tags.some((known) => sameTag(known, tag))) {
        tags.push(tag);
      }
    }
  }
  return tags.sort((left, right) => left.localeCompare(right, 'fr', { sensitivity: 'base' }));
}

export function groupEntities(entities: EntitySummary[], tag: string | null): EntityGroup[] {
  const visible =
    tag === null
      ? entities
      : entities.filter(({ entity }) => entityTags(entity).some((candidate) => sameTag(candidate, tag)));
  return KIND_GROUPS.map((group) => ({
    ...group,
    entities: visible.filter(({ entity }) => entity.kind === group.kind),
  })).filter((group) => group.entities.length > 0);
}

export function withTag(tags: string[], tag: string): string[] {
  const trimmed = tag.trim().replace(/^#+/, '').trim();
  if (trimmed === '' || tags.some((known) => sameTag(known, trimmed))) {
    return tags;
  }
  return [...tags, trimmed];
}

export function withoutTag(tags: string[], tag: string): string[] {
  return tags.filter((known) => !sameTag(known, tag));
}

export function statChips(card: EntityCard, timezone: string): string[] {
  const chips: string[] = [];
  if (card.projects.length > 0) {
    chips.push(card.projects.length === 1 ? '1 projet' : `${String(card.projects.length)} projets`);
  }
  if (card.stats.hoursLast30Days > 0) {
    chips.push(`${formatHours(card.stats.hoursLast30Days)} sur 30 jours`);
  }
  if (card.stats.lastMessageAt !== null) {
    chips.push(`dernier mail ${formatDay(card.stats.lastMessageAt, timezone)}`);
  }
  return chips;
}

export const FACT_STATUS_LABELS: Record<FactStatus, string> = {
  confirmed: 'Confirmé',
  to_verify: 'À vérifier',
  inferred: 'Déduit',
};

export const TIMELINE_KIND_LABELS: Record<string, string> = {
  message: 'Mail',
  event: 'Agenda',
  time_entry: 'Heures',
  file: 'Fichier',
  note: 'Note',
  task: 'Tâche',
  invoice: 'Facture',
};

const SOURCE_KIND_LABELS: Record<string, string> = {
  item: 'mail',
  file: 'fichier',
  job: 'agent',
};

export type FactSourceTarget =
  { type: 'job'; path: string } | { type: 'file' } | { type: 'timeline'; anchor: string };

export function entityInitials(name: string): string {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 0);
  const letters = words.length > 1 ? words.slice(0, 2).map((word) => word.charAt(0)) : [name.slice(0, 2)];
  return letters.join('').toUpperCase();
}

export function timelineAnchor(entryId: string): string {
  return `timeline-${entryId}`;
}

export function factSourceLabel(source: FactSource): string {
  const kind = SOURCE_KIND_LABELS[source.kind];
  return kind === undefined ? source.label : `${kind} · ${source.label}`;
}

export function factSourceTarget(source: FactSource): FactSourceTarget | null {
  if (source.kind === 'job') {
    return { type: 'job', path: jobPath(source.id) };
  }
  if (source.kind === 'file' && source.fileId !== null) {
    return { type: 'file' };
  }
  if (source.kind === 'item') {
    return { type: 'timeline', anchor: timelineAnchor(source.id) };
  }
  return null;
}

/**
 * Destination d'une ligne de l'historique, quand elle existe : seules les transcriptions et les PV
 * ont un écran. Mails, événements, fichiers et heures n'ont pas de page : ligne non cliquable.
 */
export function timelineTarget(
  entry: Pick<TimelineEntry, 'id' | 'kind'>,
  notes: EntityNote[],
): string | null {
  if (entry.kind !== 'note') {
    return null;
  }
  const note = notes.find((candidate) => candidate.id === entry.id);
  if (note?.noteType === 'transcript') {
    return transcriptPath(entry.id);
  }
  if (note?.noteType === 'minutes' && note.sourceId !== null) {
    return minutesPath(note.sourceId);
  }
  return null;
}

/** Écran de transcription ouvert sur l'onglet PV. */
export function minutesPath(transcriptId: string): string {
  return `${transcriptPath(transcriptId)}?tab=minutes`;
}

export function resolveSelection(entities: EntitySummary[], requestedId: string | null): string | null {
  return requestedId ?? entities[0]?.entity.id ?? null;
}

export function relativeAge(at: string, now: Date): string {
  const elapsedMs = now.getTime() - Date.parse(at);
  if (Number.isNaN(elapsedMs)) {
    return '—';
  }
  const minutes = Math.max(0, Math.floor(elapsedMs / 60_000));
  if (minutes < 1) {
    return 'à l’instant';
  }
  if (minutes < 60) {
    return `il y a ${String(minutes)} min`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `il y a ${String(hours)} h`;
  }
  const days = Math.floor(hours / 24);
  return days === 1 ? 'hier' : `il y a ${String(days)} jours`;
}

export function isSynthesizing(card: EntityCard): boolean {
  return card.activeJobs.some((job) => job.kind === 'synthesis');
}

export interface SynthesisRequest {
  entityId: string;
  baseline: string | null;
  seenRunning: boolean;
}

export function settleSynthesisRequest(
  request: SynthesisRequest | null,
  card: EntityCard,
): SynthesisRequest | null {
  if (request === null || card.entity.id !== request.entityId) {
    return request;
  }
  const running = isSynthesizing(card);
  const regenerated = (card.synthesis?.generatedAt ?? null) !== request.baseline;
  if (regenerated || (request.seenRunning && !running)) {
    return null;
  }
  return running && !request.seenRunning ? { ...request, seenRunning: true } : request;
}

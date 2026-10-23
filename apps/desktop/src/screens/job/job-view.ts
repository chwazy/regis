import type { PillTone } from '../../components/ui/StatusPill';
export { formatElapsed as formatDuration, formatTokens, formatUsd as formatCost } from '../../lib/format';
import type { Entity, EntityKind, Job, JobEvent, JobEventType, JobStatus } from '@regis/shared';
import { entityPath } from '../../lib/paths';
import { KIND_LABELS } from '../brain/brain-view';

export const STATUS_LABELS: Record<JobStatus, string> = {
  queued: 'En file',
  running: 'En cours',
  waiting_approval: 'À valider',
  done: 'Terminée',
  failed: 'Échec',
  cancelled: 'Annulée',
};

export const EVENT_KIND_LABELS: Record<JobEventType, string> = {
  start: 'début',
  message: 'message',
  tool_call: 'outil',
  tool_result: 'résultat',
  file: 'fichier',
  approval_request: 'attente',
  approval_resolved: 'validation',
  end: 'fin',
  error: 'erreur',
};

export type StatusTone = PillTone;

export const STATUS_TONES: Record<JobStatus, StatusTone> = {
  queued: 'muted',
  running: 'accent',
  waiting_approval: 'warn',
  done: 'ok',
  failed: 'danger',
  cancelled: 'muted',
};

export const ACTIVE_STATUSES: JobStatus[] = ['queued', 'running', 'waiting_approval'];

export interface JobStartInfo {
  model: string | null;
  cwd: string | null;
  worktree: { repoPath: string; branch: string } | null;
  contextRefs: { type: string; id: string }[];
}

export function isActive(status: JobStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readRefs(value: unknown): { type: string; id: string }[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry: unknown) =>
    isRecord(entry) && typeof entry.type === 'string' && typeof entry.id === 'string'
      ? [{ type: entry.type, id: entry.id }]
      : [],
  );
}

function readWorktree(value: unknown): JobStartInfo['worktree'] {
  return isRecord(value) && typeof value.repoPath === 'string' && typeof value.branch === 'string'
    ? { repoPath: value.repoPath, branch: value.branch }
    : null;
}

export function readStartInfo(events: JobEvent[]): JobStartInfo {
  const starts = events.filter((event) => event.type === 'start' && isRecord(event.payloadJson));
  const first = starts.at(0)?.payloadJson;
  const payload = isRecord(first) ? first : {};
  return {
    model: typeof payload.model === 'string' ? payload.model : null,
    cwd: typeof payload.cwd === 'string' ? payload.cwd : null,
    worktree: readWorktree(payload.worktree),
    contextRefs: readRefs(payload.contextRefs),
  };
}

export function eventDetail(event: JobEvent): string {
  if (!isRecord(event.payloadJson)) {
    return '';
  }
  const payload = event.payloadJson;
  if (event.type === 'tool_call' && typeof payload.tool === 'string') {
    return payload.tool;
  }
  if (event.type === 'start' && typeof payload.cwd === 'string') {
    return `cwd ${payload.cwd}`;
  }
  return '';
}

export function jobKindLabel(job: Pick<Job, 'kind' | 'parentId'>): string {
  if (job.kind === 'chat') {
    return 'Conversation';
  }
  return job.parentId === null ? 'Tâche' : 'Sous-tâche';
}

export function mergeEvent(events: JobEvent[], incoming: JobEvent): JobEvent[] {
  if (events.some((event) => event.id === incoming.id)) {
    return events;
  }
  return [...events, incoming].sort((left, right) => left.seq - right.seq);
}

export interface ContextRefView {
  kindLabel: string;
  name: string | null;
  /** Lien vers le Cerveau quand la référence est une entité connue. */
  to: string | null;
}

const OTHER_REF_LABELS: Record<string, string> = { file: 'Fichier', item: 'Élément' };

function isEntityKind(value: string): value is EntityKind {
  return Object.hasOwn(KIND_LABELS, value);
}

/** Libellé lisible d'une référence jointe ; jamais le type ni l'id bruts. */
export function describeContextRef(ref: { type: string; id: string }, entities: Entity[]): ContextRefView {
  if (ref.type === 'entity' || isEntityKind(ref.type)) {
    const entity = entities.find((candidate) => candidate.id === ref.id);
    if (entity) {
      return { kindLabel: KIND_LABELS[entity.kind], name: entity.name, to: entityPath(entity.id) };
    }
    return { kindLabel: isEntityKind(ref.type) ? KIND_LABELS[ref.type] : 'Entité', name: null, to: null };
  }
  return { kindLabel: OTHER_REF_LABELS[ref.type] ?? 'Référence', name: null, to: null };
}

import type {
  Recording,
  RecordingSources,
  RecordingStatus,
  SegmentSource,
  TranscriptSegment,
} from '@regis/shared';

/** Deux segments du même canal espacés de moins que cela restent dans le même tour de parole. */
export const MERGE_GAP_MS = 2000;
const LEVEL_GAIN = 5;
/** 16 kHz, 16 bits, mono. */
const BYTES_PER_SECOND_PER_SOURCE = 32_000;

export const SPEAKER_LABELS: Record<SegmentSource, string> = {
  mic: 'Moi',
  system: 'Participants',
};

export const STATUS_LABELS: Record<RecordingStatus, string> = {
  recording: 'Enregistrement en cours',
  finalizing: 'Finalisation…',
  done: 'Terminé',
  failed: 'Interrompu',
  cancelled: 'Annulé',
};

export const SOURCES_LABELS: Record<RecordingSources, string> = {
  mic: 'Micro',
  system: 'Son système',
  both: 'Micro et son système',
};

export function speakerLabel(source: SegmentSource): string {
  return SPEAKER_LABELS[source];
}

/** `hh:mm:ss`, identique au rendu de la note côté Rust. */
export function clockLabel(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}`;
}

function sameSegment(left: TranscriptSegment, right: TranscriptSegment): boolean {
  return left.source === right.source && left.startMs === right.startMs && left.text === right.text;
}

/** Ajoute un segment reçu en direct : sans doublon (rechargement concurrent), trié par début. */
export function appendSegment(
  segments: TranscriptSegment[],
  segment: TranscriptSegment,
): TranscriptSegment[] {
  if (segments.some((known) => sameSegment(known, segment))) {
    return segments;
  }
  return [...segments, segment].sort((left, right) => left.startMs - right.startMs);
}

export interface Turn {
  source: SegmentSource;
  startMs: number;
  endMs: number;
  text: string;
}

/** Un tour de parole par ligne : segments consécutifs du même canal à moins de 2 s fusionnés. */
export function buildTurns(segments: TranscriptSegment[]): Turn[] {
  const ordered = segments
    .filter((segment) => segment.text.trim() !== '')
    .sort((left, right) => left.startMs - right.startMs);
  const turns: Turn[] = [];
  for (const segment of ordered) {
    const text = segment.text.trim();
    const last = turns[turns.length - 1];
    if (last && last.source === segment.source && Math.max(0, segment.startMs - last.endMs) < MERGE_GAP_MS) {
      last.text = `${last.text} ${text}`;
      last.endMs = Math.max(last.endMs, segment.endMs);
    } else {
      turns.push({ source: segment.source, startMs: segment.startMs, endMs: segment.endMs, text });
    }
  }
  return turns;
}

export function backlogLabel(pendingChunks: number): string | null {
  if (pendingChunks <= 0) {
    return null;
  }
  return pendingChunks === 1 ? '1 bloc en attente' : `${pendingChunks} blocs en attente`;
}

export function statusLabel(recording: Recording): string {
  return STATUS_LABELS[recording.status];
}

/** Part de la jauge (0 à 1) pour un niveau RMS. */
export function levelFraction(rms: number | null): number {
  return rms === null ? 0 : Math.min(1, Math.max(0, rms * LEVEL_GAIN));
}

export function estimatedAudioBytes(durationMs: number, sources: RecordingSources): number {
  const count = sources === 'both' ? 2 : 1;
  return Math.round((durationMs / 1000) * BYTES_PER_SECOND_PER_SOURCE * count);
}

export function formatBytes(bytes: number): string {
  const mebibytes = bytes / (1024 * 1024);
  if (mebibytes < 1) {
    return `${Math.max(1, Math.round(bytes / 1024))} Ko`;
  }
  return mebibytes < 1024 ? `${mebibytes.toFixed(1)} Mo` : `${(mebibytes / 1024).toFixed(2)} Go`;
}

export type StatusTone = 'danger' | 'warn' | 'ok' | 'muted';

export const STATUS_TONES: Record<RecordingStatus, StatusTone> = {
  recording: 'danger',
  finalizing: 'warn',
  done: 'ok',
  failed: 'danger',
  cancelled: 'muted',
};

/** État transmis par les liens du Cerveau (`<Link state>`) pour que le retour mène à l'entité d'origine. */
export interface TranscriptLinkState {
  fromEntityId: string;
}

export function transcriptLinkState(entityId: string): TranscriptLinkState {
  return { fromEntityId: entityId };
}

function isLinkState(state: unknown): state is TranscriptLinkState {
  return (
    typeof state === 'object' &&
    state !== null &&
    'fromEntityId' in state &&
    typeof state.fromEntityId === 'string' &&
    state.fromEntityId !== ''
  );
}

/** Entité d'origine de la navigation, si elle est connue. */
export function originEntityId(state: unknown): string | null {
  return isLinkState(state) ? state.fromEntityId : null;
}

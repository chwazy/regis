import type { Recording, RecordingSources, StartRecordingInput } from '@regis/shared';
import { errorMessage } from './format';

export const CONSENT_TEXT =
  'J’ai informé tous les participants et ils acceptent l’enregistrement et sa transcription';

export const ECHO_TIP = 'Utilise un casque : sans casque, le micro capte aussi les participants.';

export type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/** Le bouton « Démarrer » du dialogue de consentement n'est actif qu'une fois la case cochée. */
export function canConfirmConsent(checked: boolean): boolean {
  return checked;
}

export function isSessionLive(recording: Recording | null): boolean {
  return recording !== null && (recording.status === 'recording' || recording.status === 'finalizing');
}

export function elapsedSince(startedAt: string, now: number): number {
  const started = Date.parse(startedAt);
  return Number.isFinite(started) ? Math.max(0, now - started) : 0;
}

/** `m:ss` sous une heure, `h:mm:ss` au-delà. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

export interface NewRecordingForm {
  title: string;
  sources: RecordingSources;
  entityId: string;
}

export function buildStartInput(
  form: NewRecordingForm,
  eventItemId: string | null,
  consentText: string,
): StartRecordingInput {
  const title = form.title.trim();
  return {
    title: title === '' ? null : title,
    sources: form.sources,
    eventItemId,
    entityId: form.entityId === '' ? null : form.entityId,
    consentConfirmed: true,
    consentText,
  };
}

export interface JoinWithRecordingResult {
  recording: Recording;
  openError: string | null;
}

/**
 * « Rejoindre avec enregistrement » : l'enregistrement démarre d'abord (sources `both`), puis la
 * réunion s'ouvre. Si l'ouverture échoue, l'enregistrement continue et l'erreur est rendue.
 * Un échec de `recording_start` est propagé : la réunion n'est alors pas ouverte.
 */
export async function startAndJoin(
  invoke: Invoke,
  event: { id: string; title: string },
  consentText: string,
): Promise<JoinWithRecordingResult> {
  const input: StartRecordingInput = {
    title: event.title,
    sources: 'both',
    eventItemId: event.id,
    entityId: null,
    consentConfirmed: true,
    consentText,
  };
  const recording = await invoke<Recording>('recording_start', { input });
  try {
    await invoke('open_meeting', { itemId: event.id });
    return { recording, openError: null };
  } catch (reason: unknown) {
    return { recording, openError: errorMessage(reason) };
  }
}

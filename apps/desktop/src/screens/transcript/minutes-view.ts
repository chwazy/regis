import type { Item, RecordingStatus } from '@regis/shared';

export const MINUTES_NOTE_TYPE = 'minutes';

/** Le PV se génère depuis une transcription terminée, et une seule génération à la fois. */
export function canGenerateMinutes(status: RecordingStatus, busy: boolean): boolean {
  return status === 'done' && !busy;
}

export function generateLabel(hasMinutes: boolean): string {
  return hasMinutes ? 'Régénérer le PV' : 'Générer le PV';
}

export function minutesBadge(agentName: string | null): string {
  return `Généré par ${agentName ?? 'un agent'} à partir de la transcription — à vérifier`;
}

/** Identifiant de l'agent qui a rédigé le PV, lu dans `dataJson` de la note. */
export function minutesAgentId(note: Pick<Item, 'dataJson'>): string | null {
  const data = note.dataJson;
  if (typeof data !== 'object' || data === null) {
    return null;
  }
  const agentId = (data as { agentId?: unknown }).agentId;
  return typeof agentId === 'string' && agentId !== '' ? agentId : null;
}

export function isMinutesNote(note: Pick<Item, 'dataJson'>): boolean {
  const data = note.dataJson;
  return typeof data === 'object' && data !== null && (data as { noteType?: unknown }).noteType === 'minutes';
}

export type PresenceState = 'idle' | 'listening' | 'thinking' | 'approval' | 'recording';

export interface PresenceSignals {
  recording?: boolean;
  pendingApprovals?: number;
  listening?: boolean;
  thinking?: boolean;
}

export const PRESENCE_LABELS: Record<PresenceState, string> = {
  idle: 'Régis est disponible',
  listening: 'Régis écoute',
  thinking: 'Régis réfléchit',
  approval: 'Régis attend une validation',
  recording: 'Enregistrement en cours',
};

/** L'enregistrement prime (indicateur légal), puis ce qui attend l'utilisateur. */
export function presenceState(signals: PresenceSignals): PresenceState {
  if (signals.recording) {
    return 'recording';
  }
  if ((signals.pendingApprovals ?? 0) > 0) {
    return 'approval';
  }
  if (signals.listening) {
    return 'listening';
  }
  if (signals.thinking) {
    return 'thinking';
  }
  return 'idle';
}

import type { ItemKind } from './generated/ItemKind';

export type SyncPhase = 'started' | 'done' | 'error';

export interface SyncProgress {
  connectorId: string;
  phase: SyncPhase;
  kind?: ItemKind;
  upserted?: number;
  error?: string;
}

export interface M365LoginStart {
  verificationUri: string;
  userCode: string;
  expiresAt: string;
}

export type M365LoginState = 'pending' | 'done' | 'failed';

export interface M365LoginStatus {
  state: M365LoginState;
  account?: string;
  error?: string;
}

import type { Connector, ConnectorState } from '@regis/shared';
import type { PillTone } from '../../components/ui/StatusPill';
import { formatClock, formatDateTime } from '../../lib/format';

export const STATE_LABELS: Record<ConnectorState, string> = {
  starting: 'Démarrage',
  connected: 'Connecté',
  error: 'Erreur',
  stopped: 'Arrêté',
};

export const STATE_TONES: Record<ConnectorState, PillTone> = {
  starting: 'accent',
  connected: 'ok',
  error: 'danger',
  stopped: 'muted',
};

export function connectorInitials(name: string): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter((word) => word.length > 0);
  const letters = words.length > 1 ? words.map((word) => word[0]).join('') : name.slice(0, 2);
  return letters.slice(0, 2).toUpperCase();
}

export function listedConnectors(connectors: Connector[]): Connector[] {
  return connectors.filter((connector) => connector.transport !== 'builtin');
}

export function transportLabel(connector: Connector): string {
  return connector.transport === 'builtin' ? 'intégré' : connector.transport;
}

export function authLabel(connector: Connector): string {
  return connector.secretRef ? 'secret (coffre OS)' : 'sans secret';
}

export function lastSyncLabel(connector: Connector, timezone: string): string {
  if (!connector.lastSyncAt) {
    return 'jamais synchronisé';
  }
  return `synchro ${formatDateTime(connector.lastSyncAt, timezone)}`;
}

export function clockLabel(date: Date, timezone: string): string {
  return formatClock(date, timezone);
}

/** « 0 outil », « 1 outil », « 3 outils ». */
export function toolCountLabel(count: number): string {
  return `${String(count)} ${count > 1 ? 'outils' : 'outil'}`;
}

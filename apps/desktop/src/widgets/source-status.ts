import { useEffect, useState } from 'react';
import type { Connector, ConnectorStatus } from '@regis/shared';
import { invokeCmd, onRegisEvent, sidecarCall } from '../lib/ipc';

export type SourceKind = 'm365' | 'odoo';

const SOURCE_LABELS: Record<SourceKind, string> = {
  m365: 'Microsoft 365',
  odoo: 'Odoo',
};

export function sourceErrorMessage(
  connectors: Connector[],
  statuses: Record<string, ConnectorStatus>,
  kind: SourceKind,
): string | null {
  const failing = connectors
    .filter((connector) => connector.kind === kind && connector.enabled)
    .filter((connector) => (statuses[connector.id]?.state ?? connector.status) === 'error');
  if (failing.length === 0) {
    return null;
  }
  const detail = failing.map((connector) => statuses[connector.id]?.error).find(Boolean);
  const base = `Source ${SOURCE_LABELS[kind]} indisponible (connecteur en erreur)`;
  return detail ? `${base} : ${detail}` : `${base}.`;
}

export interface SourceIssues {
  errors: string[];
  allFailing: boolean;
}

export function sourceIssues(
  connectors: Connector[],
  statuses: Record<string, ConnectorStatus>,
  kinds: SourceKind[],
): SourceIssues {
  const errors = kinds
    .map((kind) => sourceErrorMessage(connectors, statuses, kind))
    .filter((message): message is string => message !== null);
  const configured = kinds.filter((kind) =>
    connectors.some((connector) => connector.kind === kind && connector.enabled),
  );
  return { errors, allFailing: errors.length > 0 && errors.length >= configured.length };
}

export function useSourceIssues(kinds: SourceKind[]): SourceIssues {
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [statuses, setStatuses] = useState<Record<string, ConnectorStatus>>({});

  useEffect(() => {
    if (kinds.length === 0) {
      return undefined;
    }
    let active = true;
    invokeCmd<Connector[]>('list_connectors')
      .then((loaded) => active && setConnectors(loaded))
      .catch(() => undefined);
    sidecarCall<ConnectorStatus[]>('mcp.status', {})
      .then(
        (list) =>
          active && setStatuses(Object.fromEntries(list.map((status) => [status.connectorId, status]))),
      )
      .catch(() => undefined);
    const unlisten = onRegisEvent<ConnectorStatus>('connector.status', (event) =>
      setStatuses((current) => ({ ...current, [event.payload.connectorId]: event.payload })),
    );
    return () => {
      active = false;
      void unlisten.then((stop) => stop());
    };
  }, [kinds.length]);

  return sourceIssues(connectors, statuses, kinds);
}

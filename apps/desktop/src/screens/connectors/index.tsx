import { useCallback, useEffect, useState } from 'react';
import type { Connector, ConnectorStatus, McpTestResult, SyncProgress, ToolInfo } from '@regis/shared';
import { ErrorMessage, Loading } from '../../components/ui/Feedback';
import { PageHeader } from '../../components/ui/PageHeader';
import { errorMessage } from '../../lib/format';
import { invokeCmd, onRegisEvent, sidecarCall } from '../../lib/ipc';
import { useTimezone } from '../../lib/use-timezone';
import { AddConnector } from './AddConnector';
import { ConnectorCard } from './ConnectorCard';
import { ConnectorDetail } from './ConnectorDetail';
import styles from './connectors.module.css';
import { STATE_LABELS, clockLabel, listedConnectors, toolCountLabel } from './status';

const MAX_JOURNAL_LINES = 8;
const SYNCABLE_KINDS = new Set(['m365']);

function stoppedStatus(connectorId: string): ConnectorStatus {
  return { connectorId, state: 'stopped', toolCount: 0, since: new Date().toISOString() };
}

export default function ConnectorsScreen() {
  const timezone = useTimezone();
  const [connectors, setConnectors] = useState<Connector[] | null>(null);
  const [statuses, setStatuses] = useState<Record<string, ConnectorStatus>>({});
  const [loadedTools, setLoadedTools] = useState<{ connectorId: string; tools: ToolInfo[] } | null>(null);
  const [journals, setJournals] = useState<Record<string, string[]>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const appendJournal = useCallback(
    (connectorId: string, line: string) => {
      setJournals((current) => ({
        ...current,
        [connectorId]: [`${clockLabel(new Date(), timezone)} ${line}`, ...(current[connectorId] ?? [])].slice(
          0,
          MAX_JOURNAL_LINES,
        ),
      }));
    },
    [timezone],
  );

  const applyConnectors = useCallback((loaded: Connector[]) => {
    const listed = listedConnectors(loaded);
    setConnectors(listed);
    setSelectedId((current) => current ?? listed[0]?.id ?? null);
    setError(null);
  }, []);

  const loadConnectors = useCallback(
    () => invokeCmd<Connector[]>('list_connectors').then(applyConnectors),
    [applyConnectors],
  );

  useEffect(() => {
    let active = true;
    invokeCmd<Connector[]>('list_connectors')
      .then((loaded) => active && applyConnectors(loaded))
      .catch((reason: unknown) => active && setError(errorMessage(reason)));
    sidecarCall<ConnectorStatus[]>('mcp.status', {})
      .then(
        (list) =>
          active && setStatuses(Object.fromEntries(list.map((status) => [status.connectorId, status]))),
      )
      .catch(() => undefined);
    const unlisten = onRegisEvent<ConnectorStatus>('connector.status', (event) => {
      const status = event.payload;
      setStatuses((current) => ({ ...current, [status.connectorId]: status }));
      appendJournal(
        status.connectorId,
        status.error ? `${STATE_LABELS[status.state]} · ${status.error}` : STATE_LABELS[status.state],
      );
    });
    const unlistenSync = onRegisEvent<SyncProgress>('sync.progress', (event) => {
      const progress = event.payload;
      const subject = progress.kind ? `synchro ${progress.kind}` : 'synchro';
      appendJournal(
        progress.connectorId,
        progress.phase === 'started'
          ? `${subject} · démarrée`
          : progress.error
            ? `${subject} · erreur · ${progress.error}`
            : `${subject} · ${progress.upserted ?? 0} éléments`,
      );
      if (progress.phase !== 'started') {
        invokeCmd<Connector[]>('list_connectors')
          .then((loaded) => active && setConnectors(listedConnectors(loaded)))
          .catch(() => undefined);
      }
    });
    return () => {
      active = false;
      void unlisten.then((stop) => stop());
      void unlistenSync.then((stop) => stop());
    };
  }, [appendJournal, applyConnectors]);

  const list = connectors ?? [];
  const selected = list.find((connector) => connector.id === selectedId) ?? null;
  const selectedStatus = selected ? (statuses[selected.id] ?? stoppedStatus(selected.id)) : null;
  const selectedState = selectedStatus?.state;

  useEffect(() => {
    if (!selectedId || selectedState !== 'connected') {
      return;
    }
    let cancelled = false;
    sidecarCall<ToolInfo[]>('mcp.listTools', { connectorId: selectedId })
      .then((list) => !cancelled && setLoadedTools({ connectorId: selectedId, tools: list }))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [selectedId, selectedState]);

  const tools =
    selectedState === 'connected' && loadedTools?.connectorId === selectedId ? loadedTools.tools : [];

  const testConnector = async (connector: Connector): Promise<McpTestResult> => {
    try {
      const result = await sidecarCall<McpTestResult>('mcp.test', { connectorId: connector.id });
      appendJournal(
        connector.id,
        result.ok
          ? `test ok · ${toolCountLabel(result.toolCount)} · ${String(result.latencyMs)} ms`
          : `test échoué · ${result.error}`,
      );
      return result;
    } catch (reason) {
      return { ok: false, toolCount: 0, error: errorMessage(reason), latencyMs: 0 };
    }
  };

  const syncConnector = async (connector: Connector) => {
    if (SYNCABLE_KINDS.has(connector.kind)) {
      try {
        await sidecarCall('sync.run', { connectorId: connector.id });
      } catch (reason) {
        appendJournal(connector.id, `synchro impossible · ${errorMessage(reason)}`);
      }
      return;
    }
    await sidecarCall('mcp.start', { connectorId: connector.id });
    appendJournal(connector.id, 'synchronisation des outils');
  };

  const toggleEnabled = async (connector: Connector) => {
    const enabled = !connector.enabled;
    if (!enabled) {
      await sidecarCall('mcp.stop', { connectorId: connector.id });
    }
    await invokeCmd('save_connector', { connector: { ...connector, enabled } });
    await loadConnectors();
    if (enabled) {
      await sidecarCall('mcp.start', { connectorId: connector.id });
    }
  };

  const handleCreated = async (connector: Connector) => {
    await loadConnectors();
    setSelectedId(connector.id);
    try {
      await sidecarCall('mcp.start', { connectorId: connector.id });
    } catch (reason) {
      appendJournal(connector.id, `démarrage impossible · ${errorMessage(reason)}`);
    }
  };

  return (
    <div className={styles.layout}>
      <div className={styles.listColumn}>
        <PageHeader
          title="Connecteurs"
          subtitle="Chaque source est un serveur MCP. Le dashboard, le cerveau et les agents utilisent les mêmes outils."
        />

        <ErrorMessage>{error}</ErrorMessage>
        {connectors === null && !error && <Loading />}
        {connectors !== null && connectors.length === 0 && !error && (
          <p className={styles.empty}>Aucun connecteur configuré.</p>
        )}
        <div className={styles.grid}>
          {list.map((connector) => (
            <ConnectorCard
              key={connector.id}
              connector={connector}
              status={statuses[connector.id] ?? stoppedStatus(connector.id)}
              selected={connector.id === selectedId}
              onSelect={() => setSelectedId(connector.id)}
            />
          ))}
        </div>

        <AddConnector onCreated={(connector) => void handleCreated(connector)} />
      </div>

      {selected && selectedStatus && (
        <ConnectorDetail
          key={selected.id}
          connector={selected}
          status={selectedStatus}
          tools={tools}
          journal={journals[selected.id] ?? []}
          onTest={() => testConnector(selected)}
          onSync={() => syncConnector(selected)}
          onToggleEnabled={() => toggleEnabled(selected)}
        />
      )}
    </div>
  );
}

import { useState } from 'react';
import { Link } from 'react-router';
import type { Connector, ConnectorStatus, McpTestResult, ToolInfo } from '@regis/shared';
import { ROUTES } from '../../app/routes';
import controls from '../../components/ui/controls.module.css';
import { ErrorMessage } from '../../components/ui/Feedback';
import { StatusPill } from '../../components/ui/StatusPill';
import styles from './connectors.module.css';
import { M365Wizard } from './M365Wizard';
import { STATE_LABELS, STATE_TONES, toolCountLabel, transportLabel } from './status';

interface ConnectorDetailProps {
  connector: Connector;
  status: ConnectorStatus;
  tools: ToolInfo[];
  journal: string[];
  onTest: () => Promise<McpTestResult>;
  onSync: () => Promise<void>;
  onToggleEnabled: () => Promise<void>;
}

function describeConfiguration(connector: Connector): [string, string][] {
  const rows: [string, string][] = [['Transport', transportLabel(connector)]];
  if (connector.transport === 'stdio') {
    const args = Array.isArray(connector.argsJson) ? connector.argsJson.map(String) : [];
    rows.push(['Commande', [connector.command ?? '', ...args].join(' ')]);
  }
  if (connector.url) {
    rows.push(['URL', connector.url]);
  }
  const envNames =
    connector.envJson && typeof connector.envJson === 'object' ? Object.keys(connector.envJson) : [];
  if (envNames.length > 0) {
    rows.push(['Variables', envNames.join(', ')]);
  }
  rows.push(['Secret', connector.secretRef ? 'stocké dans le coffre OS' : 'aucun']);
  return rows;
}

export function ConnectorDetail({
  connector,
  status,
  tools,
  journal,
  onTest,
  onSync,
  onToggleEnabled,
}: ConnectorDetailProps) {
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState<McpTestResult | null>(null);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside aria-label="Détail du connecteur" className={styles.detail}>
      <div className={styles.detailHead}>
        <span className={styles.detailCaption}>Connecteur sélectionné</span>
        <div className={styles.detailTitleRow}>
          <h2 className={styles.detailTitle}>{connector.name}</h2>
          <StatusPill tone={STATE_TONES[status.state]} pulse={status.state === 'starting'}>
            {STATE_LABELS[status.state]}
          </StatusPill>
        </div>
        <ErrorMessage>{status.error}</ErrorMessage>
      </div>

      <section aria-label="Configuration" className={styles.section}>
        <span className={styles.sectionLabel}>Configuration</span>
        <dl className={styles.configList}>
          {describeConfiguration(connector).map(([label, value]) => (
            <div key={label} className={styles.configRow}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      {connector.kind === 'm365' && (
        <M365Wizard connector={connector} connected={status.state === 'connected'} />
      )}

      <section aria-label="Outils exposés" className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionLabel}>Outils exposés ({tools.length})</span>
          <Link to={`${ROUTES.agentSettings}?onglet=politique`} className={styles.sectionLink}>
            Politique →
          </Link>
        </div>
        {tools.length === 0 && <p className={styles.empty}>Aucun outil exposé pour le moment.</p>}
        {tools.map((tool) => (
          <div key={tool.name} className={styles.toolRow}>
            <span className={styles.toolName}>{tool.name}</span>
            <StatusPill tone={tool.access === 'read' ? 'ok' : 'warn'}>
              {tool.access === 'read' ? 'Lecture' : 'Écriture'}
            </StatusPill>
          </div>
        ))}
      </section>

      <section aria-label="Journal" className={styles.journal}>
        {journal.length === 0 && <span>Aucun événement depuis l’ouverture de l’écran.</span>}
        {journal.map((line, index) => (
          <span key={`${index}-${line}`}>{line}</span>
        ))}
      </section>

      {testResult && (
        <p role="status" className={testResult.ok ? styles.testOk : styles.testFailed}>
          {testResult.ok
            ? `Connexion OK · ${toolCountLabel(testResult.toolCount)} · ${String(testResult.latencyMs)} ms`
            : `Échec : ${testResult.error ?? 'erreur inconnue'}`}
        </p>
      )}

      <div className={styles.detailActions}>
        <button
          type="button"
          className={controls.primary}
          disabled={busy}
          onClick={() => void run(async () => setTestResult(await onTest()))}
        >
          Tester la connexion
        </button>
        <button
          type="button"
          className={controls.secondary}
          disabled={busy || !connector.enabled}
          onClick={() => void run(onSync)}
        >
          Synchroniser
        </button>
        <button
          type="button"
          className={connector.enabled ? controls.danger : controls.secondary}
          disabled={busy}
          onClick={() => void run(onToggleEnabled)}
        >
          {connector.enabled ? 'Déconnecter' : 'Connecter'}
        </button>
      </div>
    </aside>
  );
}

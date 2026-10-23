import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { Connector, FileSourceInfo } from '@regis/shared';
import { invokeCmd, sidecarCall } from '../../lib/ipc';
import { M365Wizard } from '../connectors/M365Wizard';
import { OdooForm } from '../connectors/OdooForm';
import { AddSourceForm } from '../sources/AddSourceForm';
import type { ConnectorStepId, Profile } from './onboarding-model';
import styles from './onboarding.module.css';

interface StepConnectorsProps {
  profile: Profile;
}

const CONNECTORS_PATH = '/connecteurs';

const TITLES: Record<ConnectorStepId, string> = {
  m365: 'Microsoft 365',
  odoo: 'Odoo',
  files: 'Sources de fichiers',
};

const fetchAll = () =>
  Promise.all([invokeCmd<Connector[]>('list_connectors'), invokeCmd<FileSourceInfo[]>('list_file_sources')]);

export function StepConnectors({ profile }: StepConnectorsProps) {
  const [connectors, setConnectors] = useState<Connector[] | null>(null);
  const [sources, setSources] = useState<FileSourceInfo[]>([]);
  const [later, setLater] = useState<ReadonlySet<ConnectorStepId>>(new Set());
  const [odooOpen, setOdooOpen] = useState(false);
  const [m365, setM365] = useState<{ connector: Connector; connected: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    () =>
      fetchAll()
        .then(([loadedConnectors, loadedSources]) => {
          setConnectors(loadedConnectors);
          setSources(loadedSources);
          setError(null);
        })
        .catch((reason: unknown) => setError(String(reason))),
    [],
  );

  useEffect(() => {
    let active = true;
    fetchAll()
      .then(([loadedConnectors, loadedSources]) => {
        if (active) {
          setConnectors(loadedConnectors);
          setSources(loadedSources);
        }
      })
      .catch((reason: unknown) => active && setError(String(reason)));
    return () => {
      active = false;
    };
  }, []);

  const postpone = (id: ConnectorStepId) => setLater((current) => new Set(current).add(id));
  const existing = (kind: string) => connectors?.find((connector) => connector.kind === kind) ?? null;

  const connectM365 = async () => {
    setBusy(true);
    setError(null);
    try {
      const preset = await sidecarCall<Connector>('connectors.presets.build', {
        presetId: 'm365',
        options: { name: '', tenantId: '', clientId: '' },
      });
      const saved = await invokeCmd<Connector>('save_connector', { connector: preset });
      let connected = false;
      try {
        await sidecarCall('mcp.start', { connectorId: saved.id });
        connected = true;
      } catch (reason) {
        setError(`Démarrage du connecteur impossible : ${String(reason)}`);
      }
      setM365({ connector: saved, connected });
      await load();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const configured = (id: ConnectorStepId, kind: string) => (
    <p className={styles.hint}>
      <span className={styles.pillOk}>Déjà configuré</span> {existing(kind)?.name ?? TITLES[id]} ·{' '}
      <Link to={CONNECTORS_PATH}>Gérer dans Connecteurs</Link>
    </p>
  );

  const renderM365 = () => {
    if (m365) {
      return <M365Wizard connector={m365.connector} connected={m365.connected} />;
    }
    if (existing('m365')) {
      return configured('m365', 'm365');
    }
    return (
      <div className={styles.row}>
        <button
          type="button"
          className={styles.primaryButton}
          disabled={busy}
          onClick={() => void connectM365()}
        >
          Connecter Microsoft 365
        </button>
        <button type="button" className={styles.secondaryButton} onClick={() => postpone('m365')}>
          Plus tard
        </button>
      </div>
    );
  };

  const renderOdoo = () => {
    if (existing('odoo')) {
      return configured('odoo', 'odoo');
    }
    if (odooOpen) {
      return (
        <OdooForm
          onCancel={() => setOdooOpen(false)}
          onCreated={(created) => {
            setOdooOpen(false);
            void sidecarCall('mcp.start', { connectorId: created.id })
              .catch(() => undefined)
              .then(load);
          }}
        />
      );
    }
    return (
      <div className={styles.row}>
        <button type="button" className={styles.primaryButton} onClick={() => setOdooOpen(true)}>
          Configurer Odoo
        </button>
        <button type="button" className={styles.secondaryButton} onClick={() => postpone('odoo')}>
          Plus tard
        </button>
      </div>
    );
  };

  const renderFiles = () => (
    <>
      {sources.length > 0 && (
        <p className={styles.hint}>
          {sources.length} source(s) déjà configurée(s) : {sources.map((source) => source.path).join(' · ')}
        </p>
      )}
      <AddSourceForm compact onError={setError} onAdded={load} />
      <div className={styles.row}>
        <button type="button" className={styles.secondaryButton} onClick={() => postpone('files')}>
          Plus tard
        </button>
      </div>
    </>
  );

  const renderers: Record<ConnectorStepId, () => React.ReactNode> = {
    m365: renderM365,
    odoo: renderOdoo,
    files: renderFiles,
  };

  return (
    <section className={styles.card} aria-labelledby="onboarding-connectors">
      <h2 id="onboarding-connectors" className={styles.title}>
        Connecteurs
      </h2>
      {error !== null && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {connectors === null && error === null && <p className={styles.hint}>Chargement…</p>}
      {connectors !== null &&
        profile.connectorSteps.map((id) => (
          <div key={id} className={styles.block}>
            <h3 className={styles.sectionTitle}>{TITLES[id]}</h3>
            {later.has(id) ? (
              <p className={styles.hint}>
                Reporté.{' '}
                <button
                  type="button"
                  className={styles.linkButton}
                  onClick={() =>
                    setLater((current) => {
                      const next = new Set(current);
                      next.delete(id);
                      return next;
                    })
                  }
                >
                  Reprendre
                </button>
              </p>
            ) : (
              renderers[id]()
            )}
          </div>
        ))}
      {profile.showOtherConnectorsHint && (
        <p className={styles.hint}>
          Les serveurs MCP libres se configurent dans <Link to={CONNECTORS_PATH}>Connecteurs</Link>.
        </p>
      )}
    </section>
  );
}

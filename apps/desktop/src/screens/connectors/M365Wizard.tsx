import { useEffect, useState } from 'react';
import type { Connector, M365LoginStart, M365LoginStatus } from '@regis/shared';
import controls from '../../components/ui/controls.module.css';
import { ErrorMessage } from '../../components/ui/Feedback';
import { errorMessage, formatClock } from '../../lib/format';
import { sidecarCall } from '../../lib/ipc';
import { useTimezone } from '../../lib/use-timezone';
import styles from './connectors.module.css';

const POLL_INTERVAL_MS = 3000;

interface M365WizardProps {
  connector: Connector;
  connected: boolean;
}

type WizardView =
  | { step: 'idle' }
  | { step: 'code'; start: M365LoginStart }
  | { step: 'done'; account: string | undefined }
  | { step: 'failed'; error: string };

export function M365Wizard({ connector, connected }: M365WizardProps) {
  const timezone = useTimezone();
  const [view, setView] = useState<WizardView>({ step: 'idle' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!connected) {
      return;
    }
    let active = true;
    sidecarCall<M365LoginStatus>('connectors.m365.loginStatus', { connectorId: connector.id })
      .then((status) => {
        if (active && status.state === 'done') {
          setView({ step: 'done', account: status.account });
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [connected, connector.id]);

  const waitingForCode = view.step === 'code';
  useEffect(() => {
    if (!waitingForCode) {
      return;
    }
    let active = true;
    const timer = setInterval(() => {
      sidecarCall<M365LoginStatus>('connectors.m365.loginStatus', { connectorId: connector.id })
        .then((status) => {
          if (!active) {
            return;
          }
          if (status.state === 'done') {
            setView({ step: 'done', account: status.account });
          } else if (status.state === 'failed') {
            setView({ step: 'failed', error: status.error ?? 'Connexion refusée' });
          }
        })
        .catch(() => undefined);
    }, POLL_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [waitingForCode, connector.id]);

  const begin = async (force: boolean) => {
    setBusy(true);
    try {
      const start = await sidecarCall<M365LoginStart>('connectors.m365.beginLogin', {
        connectorId: connector.id,
        force,
      });
      setView({ step: 'code', start });
    } catch (reason) {
      setView({ step: 'failed', error: errorMessage(reason) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="Connexion Microsoft 365" className={styles.section}>
      <span className={styles.sectionLabel}>Connexion Microsoft 365</span>
      {view.step === 'done' && (
        <p role="status" className={styles.testOk}>
          Connecté : {view.account ?? 'compte Microsoft 365'}
        </p>
      )}
      {view.step === 'code' && (
        <div className={styles.wizardCode}>
          <span>
            Ouvre{' '}
            <a href={view.start.verificationUri} target="_blank" rel="noreferrer">
              {view.start.verificationUri}
            </a>{' '}
            et saisis le code :
          </span>
          <span className={styles.userCode}>{view.start.userCode}</span>
          <span className={styles.mono}>
            Valable jusqu’à {formatClock(view.start.expiresAt, timezone)} · en attente de la connexion…
          </span>
        </div>
      )}
      {view.step === 'failed' && <ErrorMessage>{view.error}</ErrorMessage>}
      {!connected && (
        <p className={styles.empty}>Démarre le connecteur pour lancer la connexion au compte.</p>
      )}
      {view.step !== 'code' && (
        <div className={styles.actions}>
          <button
            type="button"
            className={view.step === 'done' ? controls.secondary : controls.primary}
            disabled={busy || !connected}
            onClick={() => void begin(view.step === 'done')}
          >
            {view.step === 'done' ? 'Changer de compte' : 'Se connecter'}
          </button>
        </div>
      )}
    </section>
  );
}

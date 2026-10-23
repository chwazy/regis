import { useState, type FormEvent } from 'react';
import type { Connector } from '@regis/shared';
import controls from '../../components/ui/controls.module.css';
import { ErrorMessage } from '../../components/ui/Feedback';
import { StatusPill } from '../../components/ui/StatusPill';
import { errorMessage } from '../../lib/format';
import { invokeCmd, sidecarCall } from '../../lib/ipc';
import { OdooForm } from './OdooForm';
import styles from './connectors.module.css';

interface AddConnectorProps {
  onCreated: (connector: Connector) => void;
}

type Way = 'stdio' | 'http' | 'm365' | 'odoo';

const DEFAULT_SECRET_ENV = 'API_KEY';

function parseLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of parseLines(text)) {
    const separator = line.indexOf('=');
    if (separator > 0) {
      env[line.slice(0, separator).trim()] = line.slice(separator + 1);
    }
  }
  return env;
}

function newSecretRef(): string {
  return `connector-${crypto.randomUUID()}`;
}

export function AddConnector({ onCreated }: AddConnectorProps) {
  const [way, setWay] = useState<Way | null>(null);
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [env, setEnv] = useState('');
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [secretEnv, setSecretEnv] = useState(DEFAULT_SECRET_ENV);
  const [tenantId, setTenantId] = useState('');
  const [clientId, setClientId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setWay(null);
    setName('');
    setCommand('');
    setArgs('');
    setEnv('');
    setUrl('');
    setSecret('');
    setSecretEnv(DEFAULT_SECRET_ENV);
    setTenantId('');
    setClientId('');
    setError(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!way) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (way === 'm365') {
        const preset = await sidecarCall<Connector>('connectors.presets.build', {
          presetId: 'm365',
          options: { name: name.trim(), tenantId: tenantId.trim(), clientId: clientId.trim() },
        });
        const saved = await invokeCmd<Connector>('save_connector', { connector: preset });
        reset();
        onCreated(saved);
        return;
      }
      const secretRef = secret ? newSecretRef() : null;
      if (secretRef) {
        await invokeCmd('set_secret', { secretRef, value: secret });
      }
      const draft: Connector = {
        id: '',
        kind: 'mcp',
        name: name.trim(),
        transport: way,
        command: way === 'stdio' ? command.trim() : null,
        argsJson: way === 'stdio' ? parseLines(args) : [],
        url: way === 'http' ? url.trim() : null,
        envJson: way === 'stdio' ? parseEnv(env) : {},
        secretRef,
        enabled: true,
        syncJson: secretRef && way === 'stdio' ? { secretEnv: secretEnv.trim() } : {},
        status: 'unknown',
        lastSyncAt: null,
        createdAt: '',
      };
      const connector = await invokeCmd<Connector>('save_connector', { connector: draft });
      reset();
      onCreated(connector);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section aria-label="Ajouter" className={styles.addPanel}>
      <h2 className={styles.addTitle}>Ajouter une source</h2>
      <div className={styles.ways}>
        <button type="button" className={styles.wayDisabled} disabled>
          <span className={styles.wayTitle}>
            Depuis le registre MCP <StatusPill tone="muted">Bientôt</StatusPill>
          </span>
          <span className={styles.wayDescription}>Serveurs connus, installation et OAuth guidés.</span>
        </button>
        <button
          type="button"
          className={way === 'm365' ? styles.wayActive : styles.way}
          onClick={() => setWay('m365')}
        >
          <span className={styles.wayTitle}>Microsoft 365</span>
          <span className={styles.wayDescription}>Mails et agenda, connexion par code appareil.</span>
        </button>
        <button
          type="button"
          className={way === 'odoo' ? styles.wayActive : styles.way}
          onClick={() => setWay('odoo')}
        >
          <span className={styles.wayTitle}>Odoo</span>
          <span className={styles.wayDescription}>Clients, projets, tâches, heures et factures.</span>
        </button>
        <button
          type="button"
          className={way === 'stdio' ? styles.wayActive : styles.way}
          onClick={() => setWay('stdio')}
        >
          <span className={styles.wayTitle}>Commande locale (stdio)</span>
          <span className={styles.wayDescription}>npx, uvx, binaire… lancé et supervisé par Régis.</span>
        </button>
        <button
          type="button"
          className={way === 'http' ? styles.wayActive : styles.way}
          onClick={() => setWay('http')}
        >
          <span className={styles.wayTitle}>URL distante (HTTP)</span>
          <span className={styles.wayDescription}>Serveur MCP déjà hébergé, avec jeton optionnel.</span>
        </button>
      </div>

      {way === 'odoo' && (
        <OdooForm
          onCancel={reset}
          onCreated={(connector) => {
            reset();
            onCreated(connector);
          }}
        />
      )}

      {way && way !== 'odoo' && (
        <form className={styles.form} onSubmit={(event) => void submit(event)}>
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="connector-name">
              Nom
            </label>
            <input
              id="connector-name"
              className={styles.input}
              required={way !== 'm365'}
              placeholder={way === 'm365' ? 'Microsoft 365' : undefined}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>

          {way === 'm365' && (
            <div className={styles.formRow}>
              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor="connector-tenant">
                  Tenant (optionnel)
                </label>
                <input
                  id="connector-tenant"
                  className={styles.input}
                  value={tenantId}
                  onChange={(event) => setTenantId(event.target.value)}
                />
              </div>
              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor="connector-client-id">
                  Client ID d’une app Entra perso (optionnel)
                </label>
                <input
                  id="connector-client-id"
                  className={styles.input}
                  value={clientId}
                  onChange={(event) => setClientId(event.target.value)}
                />
              </div>
            </div>
          )}

          {way === 'stdio' ? (
            <>
              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor="connector-command">
                  Commande
                </label>
                <input
                  id="connector-command"
                  className={styles.input}
                  required
                  placeholder="npx"
                  value={command}
                  onChange={(event) => setCommand(event.target.value)}
                />
              </div>
              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor="connector-args">
                  Arguments (un par ligne)
                </label>
                <textarea
                  id="connector-args"
                  className={styles.textarea}
                  rows={3}
                  value={args}
                  onChange={(event) => setArgs(event.target.value)}
                />
              </div>
              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor="connector-env">
                  Variables d’environnement (NOM=valeur, une par ligne)
                </label>
                <textarea
                  id="connector-env"
                  className={styles.textarea}
                  rows={3}
                  value={env}
                  onChange={(event) => setEnv(event.target.value)}
                />
              </div>
            </>
          ) : (
            way === 'http' && (
              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor="connector-url">
                  URL du serveur
                </label>
                <input
                  id="connector-url"
                  className={styles.input}
                  type="url"
                  required
                  placeholder="https://exemple.org/mcp"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                />
              </div>
            )
          )}

          {way !== 'm365' && (
            <div className={styles.formRow}>
              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor="connector-secret">
                  {way === 'http' ? 'Jeton (optionnel)' : 'Secret (optionnel)'}
                </label>
                <input
                  id="connector-secret"
                  className={styles.input}
                  type="password"
                  autoComplete="off"
                  value={secret}
                  onChange={(event) => setSecret(event.target.value)}
                />
              </div>
              {way === 'stdio' && (
                <div className={styles.field}>
                  <label className={styles.fieldLabel} htmlFor="connector-secret-env">
                    Variable recevant le secret
                  </label>
                  <input
                    id="connector-secret-env"
                    className={styles.input}
                    value={secretEnv}
                    onChange={(event) => setSecretEnv(event.target.value)}
                  />
                </div>
              )}
            </div>
          )}

          <ErrorMessage>{error}</ErrorMessage>
          <div className={styles.actions}>
            <button type="submit" className={controls.primary} disabled={saving}>
              Ajouter
            </button>
            <button type="button" className={controls.secondary} onClick={reset}>
              Annuler
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

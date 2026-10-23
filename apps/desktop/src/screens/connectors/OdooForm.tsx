import { useState, type FormEvent } from 'react';
import type { Connector } from '@regis/shared';
import controls from '../../components/ui/controls.module.css';
import { ErrorMessage } from '../../components/ui/Feedback';
import { errorMessage } from '../../lib/format';
import { invokeCmd, sidecarCall } from '../../lib/ipc';
import styles from './connectors.module.css';

interface OdooFormProps {
  onCreated: (connector: Connector) => void;
  onCancel: () => void;
}

export function OdooForm({ onCreated, onCancel }: OdooFormProps) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [db, setDb] = useState('');
  const [login, setLogin] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const secretRef = `connector-${crypto.randomUUID()}`;
      await invokeCmd('set_secret', { secretRef, value: apiKey });
      const preset = await sidecarCall<Connector>('connectors.presets.build', {
        presetId: 'odoo',
        options: { name: name.trim(), url: url.trim(), db: db.trim(), login: login.trim() },
      });
      const saved = await invokeCmd<Connector>('save_connector', {
        connector: { ...preset, secretRef },
      });
      onCreated(saved);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className={styles.form} onSubmit={(event) => void submit(event)}>
      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor="odoo-name">
          Nom
        </label>
        <input
          id="odoo-name"
          className={styles.input}
          placeholder="Odoo"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor="odoo-url">
          URL de l’instance
        </label>
        <input
          id="odoo-url"
          className={styles.input}
          type="url"
          required
          placeholder="https://exemple.odoo.com"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
      </div>
      <div className={styles.formRow}>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="odoo-db">
            Base de données
          </label>
          <input
            id="odoo-db"
            className={styles.input}
            required
            value={db}
            onChange={(event) => setDb(event.target.value)}
          />
        </div>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="odoo-login">
            Identifiant
          </label>
          <input
            id="odoo-login"
            className={styles.input}
            required
            autoComplete="off"
            value={login}
            onChange={(event) => setLogin(event.target.value)}
          />
        </div>
      </div>
      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor="odoo-api-key">
          Clé API
        </label>
        <input
          id="odoo-api-key"
          className={styles.input}
          type="password"
          required
          autoComplete="off"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
        />
      </div>
      <ErrorMessage>{error}</ErrorMessage>
      <div className={styles.actions}>
        <button type="submit" className={controls.primary} disabled={saving}>
          Ajouter
        </button>
        <button type="button" className={controls.secondary} onClick={onCancel}>
          Annuler
        </button>
      </div>
    </form>
  );
}

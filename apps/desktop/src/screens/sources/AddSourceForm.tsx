import { useState, type FormEvent } from 'react';
import type { FileSourceInfo } from '@regis/shared';
import controls from '../../components/ui/controls.module.css';
import { errorMessage } from '../../lib/format';
import { invokeCmd } from '../../lib/ipc';
import styles from './sources.module.css';

type NewSourceKind = 'local' | 'smb';

const DEFAULT_POLL_MINUTES = 10;

interface AddSourceFormProps {
  onAdded: () => void | Promise<void>;
  onError: (message: string) => void;
  /** Formulaire réduit (type + chemin) : le délai de scan réseau garde sa valeur par défaut. */
  compact?: boolean;
}

export function AddSourceForm({ onAdded, onError, compact = false }: AddSourceFormProps) {
  const [kind, setKind] = useState<NewSourceKind>('local');
  const [path, setPath] = useState('');
  const [pollMinutes, setPollMinutes] = useState(DEFAULT_POLL_MINUTES);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await invokeCmd<FileSourceInfo>('add_file_source', {
        kind,
        path,
        watchMode: kind === 'smb' ? 'poll' : 'realtime',
        pollMinutes: kind === 'smb' ? pollMinutes : null,
      });
      setPath('');
      await onAdded();
    } catch (reason: unknown) {
      onError(errorMessage(reason));
    }
  };

  return (
    <form className={styles.addForm} onSubmit={(event) => void submit(event)}>
      <label className={styles.field}>
        Type
        <select
          className={controls.select}
          value={kind}
          onChange={(event) => setKind(event.target.value as NewSourceKind)}
        >
          <option value="local">Dossier local</option>
          <option value="smb">Partage réseau (UNC)</option>
        </select>
      </label>
      <label className={styles.fieldWide}>
        {kind === 'smb' ? 'Chemin réseau' : 'Dossier'}
        <input
          className={controls.input}
          value={path}
          onChange={(event) => setPath(event.target.value)}
          placeholder={kind === 'smb' ? '\\\\serveur\\partage' : 'Chemin du dossier'}
          required
        />
      </label>
      {kind === 'smb' && !compact && (
        <label className={styles.field}>
          Scan (minutes)
          <input
            className={controls.input}
            type="number"
            min={1}
            value={pollMinutes}
            onChange={(event) => setPollMinutes(Number(event.target.value) || DEFAULT_POLL_MINUTES)}
          />
        </label>
      )}
      <button type="submit" className={controls.primary}>
        Ajouter
      </button>
    </form>
  );
}

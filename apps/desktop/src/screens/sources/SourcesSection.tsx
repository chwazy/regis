import { useCallback, useEffect, useState } from 'react';
import type { FileSourceInfo } from '@regis/shared';
import card from '../../components/ui/card.module.css';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import controls from '../../components/ui/controls.module.css';
import { ErrorMessage } from '../../components/ui/Feedback';
import { StatusPill } from '../../components/ui/StatusPill';
import { errorMessage } from '../../lib/format';
import { invokeCmd, onRegisEvent } from '../../lib/ipc';
import { indexingModeLabel } from '../../lib/local-modules';
import { useModuleOn } from '../../lib/use-local-modules';
import { AddSourceForm } from './AddSourceForm';
import { folderName, sourceState } from './sources-view';
import styles from './sources.module.css';

const KIND_LABELS: Record<string, string> = {
  local: 'Local',
  smb: 'Réseau SMB',
  regis: 'Régis',
  cloud: 'Cloud',
};

const KIND_NOTES: Record<string, string> = {
  local: 'dossier local',
  smb: 'session Windows',
  regis: 'bibliothèque de Régis',
  cloud: 'via connecteur',
};

const DEFAULT_POLL_MINUTES = 10;

function watchLabel(source: FileSourceInfo): string {
  if (!source.indexed) {
    return '—';
  }
  if (source.watchMode === 'poll') {
    const scan = `scan ${String(source.pollMinutes ?? DEFAULT_POLL_MINUTES)} min`;
    return source.kind === 'smb' ? `${scan} + notif.` : scan;
  }
  return source.watchMode === 'delta' ? 'delta API' : 'temps réel';
}

function countLabel(source: FileSourceInfo): string {
  if (!source.indexed || (source.state === 'offline' && source.fileCount === 0)) {
    return '—';
  }
  return source.fileCount.toLocaleString('fr-CH');
}

export function SourcesSection() {
  const semanticOn = useModuleOn('embeddings');
  const [sources, setSources] = useState<FileSourceInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<FileSourceInfo | null>(null);

  const load = useCallback(
    () =>
      invokeCmd<FileSourceInfo[]>('list_file_sources')
        .then((loaded) => {
          setSources(loaded);
          setError(null);
        })
        .catch((reason: unknown) => setError(errorMessage(reason))),
    [],
  );

  useEffect(() => {
    void load();
    const unlisten = onRegisEvent<FileSourceInfo>('index.progress', (event) => {
      const updated = event.payload;
      setSources((current) => {
        const known = current ?? [];
        return known.some((source) => source.id === updated.id)
          ? known.map((source) => (source.id === updated.id ? updated : source))
          : [...known, updated];
      });
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, [load]);

  const list = sources ?? [];
  const indexedTotal = list.reduce((total, source) => total + source.indexedCount, 0);

  const run = (command: string, id: string) =>
    invokeCmd<void>(command, { id })
      .then(load)
      .catch((reason: unknown) => setError(errorMessage(reason)));

  return (
    <section aria-labelledby="sources-title" className={`${card.card} ${styles.tableSection}`}>
      <div className={card.head}>
        <h2 id="sources-title" className={card.title}>
          Sources de fichiers
        </h2>
        <span className={card.aside}>
          {indexedTotal.toLocaleString('fr-CH')} fichiers indexés · {indexingModeLabel(semanticOn)}
        </span>
        <div className={card.right}>
          <button type="button" className={controls.secondarySm} onClick={() => setAdding((open) => !open)}>
            + Source (local, réseau)
          </button>
        </div>
      </div>
      {adding && (
        <AddSourceForm
          onError={setError}
          onAdded={async () => {
            setAdding(false);
            await load();
          }}
        />
      )}
      {error && (
        <div className={styles.sectionPad}>
          <ErrorMessage>{error}</ErrorMessage>
        </div>
      )}
      {sources !== null && list.length === 0 && <p className={card.empty}>Aucune source.</p>}
      {list.length > 0 && (
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Emplacement</th>
              <th scope="col">Type</th>
              <th scope="col">Surveillance</th>
              <th scope="col">Fichiers</th>
              <th scope="col">État</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {list.map((source) => {
              const state = sourceState(source);
              return (
                <tr key={source.id}>
                  <td>
                    <div className={styles.location}>
                      <span className={styles.path} title={source.path}>
                        {folderName(source.path)}
                      </span>
                      <span className={styles.note}>{KIND_NOTES[source.kind] ?? source.kind}</span>
                    </div>
                  </td>
                  <td>{KIND_LABELS[source.kind] ?? source.kind}</td>
                  <td className={styles.watch}>{watchLabel(source)}</td>
                  <td className={styles.count}>{countLabel(source)}</td>
                  <td>
                    <div className={styles.stateCell}>
                      <StatusPill tone={state.tone}>{state.text}</StatusPill>
                      {source.unclassifiedCount > 0 && (
                        <StatusPill tone="warn">{source.unclassifiedCount} à classer</StatusPill>
                      )}
                    </div>
                  </td>
                  <td>
                    <div className={styles.rowActions}>
                      {source.indexed && (
                        <button
                          type="button"
                          className={controls.ghostSm}
                          onClick={() => void run('rescan_source', source.id)}
                        >
                          Rescanner
                        </button>
                      )}
                      {source.kind !== 'regis' && (
                        <button
                          type="button"
                          className={controls.dangerSm}
                          onClick={() => setRemoving(source)}
                        >
                          Retirer
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {removing && (
        <ConfirmDialog
          title="Retirer cette source ?"
          confirmLabel="Retirer"
          onConfirm={() => run('remove_file_source', removing.id)}
          onClose={() => setRemoving(null)}
        >
          La source « {folderName(removing.path)} » ne sera plus surveillée ni indexée. Les fichiers eux-mêmes
          ne sont pas touchés.
        </ConfirmDialog>
      )}
    </section>
  );
}

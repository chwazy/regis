import { useCallback, useEffect, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import type { Entity, FileEntry } from '@regis/shared';
import controls from '../../components/ui/controls.module.css';
import { ErrorMessage } from '../../components/ui/Feedback';
import { errorMessage, formatDateTime } from '../../lib/format';
import { invokeCmd, onRegisEvent, sidecarCall } from '../../lib/ipc';
import { useModuleOn } from '../../lib/use-local-modules';
import { useTimezone } from '../../lib/use-timezone';
import styles from './sources.module.css';
import { topSuggestedEntity, type EntitySuggestion } from './suggestions';

const LINK_RELATIONS = [
  { value: 'belongs_to', label: 'appartient à' },
  { value: 'about', label: 'concerne' },
] as const;

function readAsBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(new Error('lecture de l’image impossible'));
    reader.readAsDataURL(blob);
  });
}

function importedAt(file: FileEntry, timezone: string): string {
  return `importé · ${formatDateTime(file.mtime, timezone)}`;
}

interface FileSuggestionProps {
  suggested: Entity | undefined;
  onLink: (entityId: string) => void;
  onOther: () => void;
}

function FileSuggestion({ suggested, onLink, onOther }: FileSuggestionProps) {
  if (!suggested) {
    return (
      <button type="button" className={controls.primarySm} onClick={onOther}>
        Lier…
      </button>
    );
  }
  return (
    <div className={styles.linkPicker}>
      <span className={styles.hint}>Suggestion : {suggested.name}</span>
      <button type="button" className={controls.primarySm} onClick={() => onLink(suggested.id)}>
        Lier
      </button>
      <button type="button" className={controls.secondarySm} onClick={onOther}>
        Autre…
      </button>
    </div>
  );
}

export function ImportSection() {
  const timezone = useTimezone();
  const semanticOn = useModuleOn('embeddings');
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [entities, setEntities] = useState<Entity[] | null>(null);
  const [dragging, setDragging] = useState(false);
  const [linking, setLinking] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Record<string, EntitySuggestion[]>>({});
  const [entityId, setEntityId] = useState('');
  const [relation, setRelation] = useState<string>(LINK_RELATIONS[0].value);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    () =>
      invokeCmd<FileEntry[]>('list_files', { role: 'imported', unlinkedOnly: true })
        .then((loaded) => {
          setFiles(loaded);
          setError(null);
        })
        .catch((reason: unknown) => setError(errorMessage(reason))),
    [],
  );

  const importPaths = useCallback(
    (paths: string[]) =>
      invokeCmd<FileEntry[]>('import_files', { paths })
        .then(load)
        .catch((reason: unknown) => setError(errorMessage(reason))),
    [load],
  );

  useEffect(() => {
    void load();
    const unlistenProgress = onRegisEvent('index.progress', () => void load());
    // Hors de Tauri (navigateur + pont de dev), pas de webview : le glisser-déposer de chemins est indisponible.
    const unlistenDrop = !isTauri()
      ? Promise.resolve(() => undefined)
      : getCurrentWebview().onDragDropEvent((event) => {
          const payload = event.payload;
          if (payload.type === 'enter' || payload.type === 'over') {
            setDragging(true);
          } else if (payload.type === 'drop') {
            setDragging(false);
            void importPaths(payload.paths);
          } else {
            setDragging(false);
          }
        });
    const onPaste = (event: ClipboardEvent) => {
      const image = Array.from(event.clipboardData?.items ?? []).find((item) =>
        item.type.startsWith('image/'),
      );
      const blob = image?.getAsFile();
      if (!blob) {
        return;
      }
      event.preventDefault();
      void readAsBase64(blob)
        .then((pngBase64) => invokeCmd<FileEntry>('import_clipboard_image', { pngBase64 }))
        .then(load)
        .catch((reason: unknown) => setError(errorMessage(reason)));
    };
    window.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('paste', onPaste);
      void unlistenProgress.then((stop) => stop());
      void unlistenDrop.then((stop) => stop());
    };
  }, [importPaths, load]);

  const loadEntities = useCallback(
    () =>
      invokeCmd<Entity[]>('list_linkable_entities')
        .then(setEntities)
        .catch((reason: unknown) => setError(errorMessage(reason))),
    [],
  );

  useEffect(() => {
    void loadEntities();
  }, [loadEntities]);

  useEffect(() => {
    if (!semanticOn) {
      return;
    }
    const toSuggest = files.filter((file) => file.status === 'indexed' && suggestions[file.id] === undefined);
    for (const file of toSuggest) {
      sidecarCall<EntitySuggestion[]>('brain.suggestEntity', { fileId: file.id })
        .then((found) => setSuggestions((current) => ({ ...current, [file.id]: found })))
        .catch(() => undefined);
    }
  }, [files, suggestions, semanticOn]);

  const openLinker = (fileId: string) => {
    setLinking(fileId);
    setEntityId('');
  };

  const linkTo = (fileId: string, targetEntityId: string) =>
    invokeCmd('link_file', { fileId, entityId: targetEntityId, rel: relation })
      .then(() => {
        setLinking(null);
        return load();
      })
      .catch((reason: unknown) => setError(errorMessage(reason)));

  const link = (fileId: string) => linkTo(fileId, entityId);

  return (
    <section aria-label="Importés à classer" className={styles.section}>
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>Importés à classer</h2>
        <span className={styles.hint}>
          fichiers sans emplacement d’origine, gardés dans la bibliothèque de Régis
        </span>
      </div>
      <div className={dragging ? styles.dropZoneActive : styles.dropZone}>
        Glisse des fichiers ici ou colle une capture (Ctrl V)
      </div>
      <ErrorMessage>{error}</ErrorMessage>
      {files.length === 0 && <p className={styles.empty}>Rien à classer.</p>}
      {files.map((file) => (
        <div key={file.id} className={styles.inboxRow}>
          <span className={styles.ext}>{file.ext.toUpperCase() || '—'}</span>
          <div className={styles.fileInfo}>
            <span className={styles.fileName}>{file.relPath}</span>
            <span className={styles.hint}>{importedAt(file, timezone)}</span>
          </div>
          {linking === file.id ? (
            <div className={styles.linkPicker}>
              <label className={styles.field}>
                Rattacher à
                <select
                  className={controls.select}
                  value={entityId}
                  onChange={(event) => setEntityId(event.target.value)}
                >
                  <option value="">Choisir…</option>
                  {(entities ?? []).map((entity) => (
                    <option key={entity.id} value={entity.id}>
                      {entity.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className={styles.field}>
                Relation
                <select
                  className={controls.select}
                  value={relation}
                  onChange={(event) => setRelation(event.target.value)}
                >
                  {LINK_RELATIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className={controls.primarySm}
                disabled={entityId === ''}
                onClick={() => void link(file.id)}
              >
                Lier
              </button>
              <button type="button" className={controls.secondarySm} onClick={() => setLinking(null)}>
                Annuler
              </button>
            </div>
          ) : (
            <FileSuggestion
              suggested={topSuggestedEntity(suggestions[file.id], entities)}
              onLink={(suggestedId) => void linkTo(file.id, suggestedId)}
              onOther={() => openLinker(file.id)}
            />
          )}
        </div>
      ))}
    </section>
  );
}

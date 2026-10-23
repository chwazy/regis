import { useState } from 'react';
import type { LocalModuleStatus } from '@regis/shared';
import { errorMessage } from '../lib/format';
import {
  canDeleteModel,
  deleteModelLabel,
  isSwitchChecked,
  MODULE_INFO,
  modelSizeLabel,
  moduleStateLabel,
  OLLAMA_INSTALL_URL,
  toggleIntent,
} from '../lib/local-modules';
import { useLocalModules, useModuleActions } from '../lib/use-local-modules';
import { progressPercent } from '../screens/voice/voice-labels';
import { ConfirmDialog } from './ui/ConfirmDialog';
import controls from './ui/controls.module.css';
import { Dialog } from './ui/Dialog';
import dialog from './ui/dialog.module.css';
import { ErrorMessage } from './ui/Feedback';
import { StatusPill, type PillTone } from './ui/StatusPill';
import styles from './LocalModuleRow.module.css';

type OpenDialog = 'download' | 'ollamaHelp' | 'delete' | null;

const STATE_TONE: Record<LocalModuleStatus['state'], PillTone> = {
  on: 'ok',
  downloading: 'accent',
  off: 'muted',
};

function copyToClipboard(text: string): void {
  void navigator.clipboard.writeText(text).catch(() => undefined);
}

export function LocalModuleRow({ module }: { module: LocalModuleStatus }) {
  const { progress, backfill } = useLocalModules();
  const actions = useModuleActions();
  const [openDialog, setOpenDialog] = useState<OpenDialog>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const info = MODULE_INFO[module.id];
  const downloading = module.state === 'downloading';
  const downloadProgress = progress[module.id];
  const downloaded = downloadProgress?.downloadedBytes ?? module.downloadedBytes;
  const total = downloadProgress?.totalBytes ?? module.sizeBytes;
  const titleId = `local-module-${module.id}`;

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const applyIntent = (status: LocalModuleStatus) => {
    switch (toggleIntent(status)) {
      case 'locked':
        return;
      case 'disable':
        void run(() => actions.disable(status.id));
        return;
      case 'enable':
        void run(() => actions.enable(status.id));
        return;
      case 'confirmDownload':
        setOpenDialog('download');
        return;
      case 'ollamaHelp':
        setOpenDialog('ollamaHelp');
        return;
    }
  };

  const onToggle = () => {
    if (isSwitchChecked(module) || module.state === 'downloading') {
      applyIntent(module);
      return;
    }
    void run(async () => {
      applyIntent((await actions.check(module.id)) ?? module);
    });
  };

  return (
    <div className={styles.row}>
      <div className={styles.head}>
        <div className={styles.identity}>
          <h3 id={titleId} className={styles.name}>
            {info.name}
          </h3>
          <p className={styles.description}>{info.description}</p>
        </div>
        <div className={styles.controls}>
          <span className={styles.size}>
            {module.modelLabel} · {modelSizeLabel(module)}
          </span>
          <StatusPill tone={STATE_TONE[module.state]} dot>
            {moduleStateLabel(module)}
          </StatusPill>
          <label className={styles.switch}>
            <input
              type="checkbox"
              role="switch"
              className="sr-only"
              aria-labelledby={titleId}
              checked={isSwitchChecked(module)}
              disabled={busy || downloading}
              onChange={onToggle}
            />
            <span className={styles.track} aria-hidden="true" />
          </label>
          {module.canDeleteModel && (
            <button
              type="button"
              className={controls.secondarySm}
              disabled={busy || !canDeleteModel(module)}
              onClick={() => setOpenDialog('delete')}
            >
              {deleteModelLabel(module)}
            </button>
          )}
        </div>
      </div>
      {downloading && (
        <div className={styles.progressRow}>
          <progress
            className={styles.progress}
            aria-label={`Progression du téléchargement : ${info.name}`}
            max={100}
            value={progressPercent(downloaded, total)}
          />
        </div>
      )}
      {module.id === 'embeddings' && module.state === 'on' && backfill !== null && (
        <div className={styles.progressRow}>
          <progress
            className={styles.progress}
            aria-label="Indexation sémantique des documents existants"
            max={backfill.total}
            value={backfill.done}
          />
          <span className={styles.size}>
            {backfill.done} / {backfill.total}
          </span>
        </div>
      )}
      <ErrorMessage>{error ?? (module.state === 'off' ? module.error : null)}</ErrorMessage>

      {openDialog === 'download' && (
        <ConfirmDialog
          title={`Activer ${info.name.toLowerCase()}`}
          confirmLabel="Télécharger et activer"
          tone="primary"
          onConfirm={() => run(() => actions.enable(module.id))}
          onClose={() => setOpenDialog(null)}
        >
          Le modèle {module.modelLabel} ({modelSizeLabel(module)}) sera {info.provenance}.
        </ConfirmDialog>
      )}
      {openDialog === 'delete' && (
        <ConfirmDialog
          title="Supprimer le modèle"
          confirmLabel="Supprimer"
          onConfirm={() => run(() => actions.deleteModel(module.id))}
          onClose={() => setOpenDialog(null)}
        >
          Le modèle {module.modelLabel} sera supprimé de ce PC. Réactiver le module obligera à le télécharger
          de nouveau.
        </ConfirmDialog>
      )}
      {openDialog === 'ollamaHelp' && module.modelState === 'unreachable' && (
        <Dialog labelledBy="ollama-help-title" size="sm" onClose={() => setOpenDialog(null)}>
          <h2 id="ollama-help-title" className={dialog.title}>
            Ollama est injoignable
          </h2>
          <p className={controls.hint}>
            La recherche sémantique utilise Ollama. Installez-le, démarrez-le, puis revérifiez.
          </p>
          <code className={styles.command}>{OLLAMA_INSTALL_URL}</code>
          <div className={dialog.actions}>
            <button
              type="button"
              className={controls.secondary}
              onClick={() => copyToClipboard(OLLAMA_INSTALL_URL)}
            >
              Copier
            </button>
            <button
              type="button"
              className={controls.secondary}
              disabled={busy}
              onClick={() => void run(actions.recheck)}
            >
              Revérifier
            </button>
            <button type="button" className={controls.primary} onClick={() => setOpenDialog(null)}>
              Fermer
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

import { useState, type ReactNode } from 'react';
import controls from './controls.module.css';
import { Dialog } from './Dialog';
import dialog from './dialog.module.css';

interface ConfirmDialogProps {
  title: string;
  confirmLabel: string;
  children?: ReactNode;
  /** `danger` pour une action destructive ou irréversible. */
  tone?: 'danger' | 'primary';
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
}

export function ConfirmDialog({
  title,
  confirmLabel,
  children,
  tone = 'danger',
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    setBusy(true);
    try {
      await onConfirm();
      onClose();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog labelledBy="confirm-dialog-title" size="sm" onClose={onClose}>
      <h2 id="confirm-dialog-title" className={dialog.title}>
        {title}
      </h2>
      {children && <div className={controls.hint}>{children}</div>}
      <div className={dialog.actions}>
        <button type="button" className={controls.secondary} disabled={busy} onClick={onClose}>
          Retour
        </button>
        <button
          type="button"
          className={tone === 'danger' ? controls.dangerSolid : controls.primary}
          disabled={busy}
          onClick={() => void confirm()}
        >
          {confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}

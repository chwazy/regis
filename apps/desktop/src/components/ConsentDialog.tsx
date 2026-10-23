import { useId, useState } from 'react';
import { CONSENT_TEXT, canConfirmConsent } from '../lib/recording';
import { ErrorMessage } from './ui/Feedback';
import controls from './ui/controls.module.css';
import { Dialog } from './ui/Dialog';
import dialog from './ui/dialog.module.css';
import styles from './ConsentDialog.module.css';

export interface ConsentDialogProps {
  /** Reçoit le texte affiché, à enregistrer avec la session. */
  onConfirm: (consentText: string) => void;
  onCancel: () => void;
  busy?: boolean;
  error?: string | null;
}

export function ConsentDialog({ onConfirm, onCancel, busy = false, error = null }: ConsentDialogProps) {
  const [checked, setChecked] = useState(false);
  const titleId = useId();

  return (
    <Dialog labelledBy={titleId} size="sm" onClose={onCancel}>
      <h2 id={titleId} className={dialog.title}>
        Enregistrer la réunion
      </h2>
      <p className={styles.text}>
        Le son sélectionné sera enregistré puis transcrit sur cet ordinateur. L’enregistrement reste signalé
        tant qu’il dure.
      </p>
      <label className={styles.consent}>
        <input type="checkbox" checked={checked} onChange={(event) => setChecked(event.target.checked)} />
        <span>{CONSENT_TEXT}</span>
      </label>
      <ErrorMessage>{error}</ErrorMessage>
      <div className={dialog.actions}>
        <button type="button" className={controls.secondary} onClick={onCancel}>
          Annuler
        </button>
        <button
          type="button"
          className={controls.primary}
          disabled={!canConfirmConsent(checked) || busy}
          onClick={() => onConfirm(CONSENT_TEXT)}
        >
          Démarrer
        </button>
      </div>
    </Dialog>
  );
}

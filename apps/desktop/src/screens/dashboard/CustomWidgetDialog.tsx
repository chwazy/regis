import { useEffect, useState } from 'react';
import { CustomWidgetSpec, customSpecFieldErrors } from '@regis/shared';
import { Dialog } from '../../components/ui/Dialog';
import dialog from '../../components/ui/dialog.module.css';
import { ErrorMessage } from '../../components/ui/Feedback';
import { errorMessage } from '../../lib/format';
import { sidecarCall } from '../../lib/ipc';
import { CustomWidget } from '../../widgets/CustomWidget';
import styles from './dashboard.module.css';

interface CustomWidgetDialogProps {
  description: string;
  onAdd: (spec: CustomWidgetSpec) => void;
  onClose: () => void;
}

type Generation =
  { phase: 'running' } | { phase: 'failed'; message: string } | { phase: 'ready'; spec: CustomWidgetSpec };

export function CustomWidgetDialog({ description, onAdd, onClose }: CustomWidgetDialogProps) {
  const [generation, setGeneration] = useState<Generation>({ phase: 'running' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    sidecarCall<{ spec: unknown }>('widgets.generateCustom', { description })
      .then((result) => {
        const parsed = CustomWidgetSpec.safeParse(result.spec);
        if (cancelled) {
          return;
        }
        if (!parsed.success) {
          setGeneration({ phase: 'failed', message: `Définition invalide : ${parsed.error.message}` });
          return;
        }
        const fieldErrors = customSpecFieldErrors(parsed.data);
        setGeneration(
          fieldErrors.length === 0
            ? { phase: 'ready', spec: parsed.data }
            : { phase: 'failed', message: `Définition invalide : ${fieldErrors.join(' ; ')}` },
        );
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setGeneration({ phase: 'failed', message: errorMessage(reason) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [description, attempt]);

  const regenerate = () => {
    setGeneration({ phase: 'running' });
    setAttempt((current) => current + 1);
  };

  return (
    <Dialog labelledBy="custom-widget-title" size="sm" onClose={onClose}>
      <h2 id="custom-widget-title" className={dialog.title}>
        Widget sur mesure
      </h2>
      <span className={styles.muted}>{description}</span>
      {generation.phase === 'running' && <span className={styles.muted}>Génération en cours…</span>}
      {generation.phase === 'failed' && <ErrorMessage>{generation.message}</ErrorMessage>}
      {generation.phase === 'ready' && (
        <>
          <strong>{generation.spec.title}</strong>
          <div className={styles.dialogPreview} aria-label="Aperçu du widget">
            <CustomWidget config={generation.spec} widgetId="preview" />
          </div>
        </>
      )}
      <div className={dialog.actions}>
        <button type="button" className={styles.secondary} onClick={onClose}>
          Annuler
        </button>
        <button
          type="button"
          className={styles.secondary}
          disabled={generation.phase === 'running'}
          onClick={regenerate}
        >
          Régénérer
        </button>
        <button
          type="button"
          className={styles.primary}
          disabled={generation.phase !== 'ready'}
          onClick={() => generation.phase === 'ready' && onAdd(generation.spec)}
        >
          Ajouter
        </button>
      </div>
    </Dialog>
  );
}

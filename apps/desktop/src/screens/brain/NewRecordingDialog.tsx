import { useEffect, useId, useState } from 'react';
import { useNavigate } from 'react-router';
import type { Entity, Recording, RecordingSources, RecordingView } from '@regis/shared';
import { ConsentDialog } from '../../components/ConsentDialog';
import { ErrorMessage } from '../../components/ui/Feedback';
import controls from '../../components/ui/controls.module.css';
import { Dialog } from '../../components/ui/Dialog';
import dialog from '../../components/ui/dialog.module.css';
import { errorMessage } from '../../lib/format';
import { invokeCmd } from '../../lib/ipc';
import { transcriptPath } from '../../lib/paths';
import { ECHO_TIP, buildStartInput } from '../../lib/recording';
import { useModuleOn } from '../../lib/use-local-modules';
import { useActiveRecording, useRecordingCapabilities } from '../../lib/use-recording';
import styles from './NewRecordingDialog.module.css';

interface NewRecordingDialogProps {
  onClose: () => void;
  /** Entité présélectionnée (celle de la fiche ouverte). */
  defaultEntityId?: string | null;
}

interface SourceOption {
  value: RecordingSources;
  label: string;
  needsLoopback: boolean;
}

const SOURCE_OPTIONS: SourceOption[] = [
  { value: 'mic', label: 'Micro', needsLoopback: false },
  { value: 'system', label: 'Son système', needsLoopback: true },
  { value: 'both', label: 'Micro et son système', needsLoopback: true },
];

export function NewRecordingDialog(props: NewRecordingDialogProps) {
  const voiceOn = useModuleOn('voice');
  return voiceOn ? <ActiveNewRecordingDialog {...props} /> : null;
}

function ActiveNewRecordingDialog({ onClose, defaultEntityId = null }: NewRecordingDialogProps) {
  const navigate = useNavigate();
  const titleId = useId();
  const capabilities = useRecordingCapabilities();
  const active = useActiveRecording();
  const [title, setTitle] = useState('');
  const [sources, setSources] = useState<RecordingSources>('mic');
  const [entityId, setEntityId] = useState(defaultEntityId ?? '');
  const [entities, setEntities] = useState<Entity[]>([]);
  const [consentOpen, setConsentOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invokeCmd<Entity[]>('list_linkable_entities')
      .then(setEntities)
      .catch((reason: unknown) => setError(errorMessage(reason)));
  }, []);

  const captureSupported = capabilities?.captureSupported === true;
  const loopbackSupported = capabilities?.loopbackSupported === true;
  const available = (option: SourceOption) =>
    captureSupported && (loopbackSupported || !option.needsLoopback);
  const selected = SOURCE_OPTIONS.find((option) => option.value === sources);
  const canContinue = captureSupported && (selected === undefined || available(selected));

  const start = (consentText: string) => {
    setBusy(true);
    setError(null);
    const input = buildStartInput({ title, sources, entityId }, null, consentText);
    invokeCmd<Recording>('recording_start', { input })
      .then((recording) => invokeCmd<RecordingView>('recording_get', { transcriptItemId: recording.id }))
      .then((view) => {
        onClose();
        void navigate(transcriptPath(view.transcriptItemId));
      })
      .catch((reason: unknown) => setError(errorMessage(reason)))
      .finally(() => setBusy(false));
  };

  return (
    <>
      <Dialog labelledBy={titleId} onClose={onClose} size="sm">
        <h2 id={titleId} className={dialog.title}>
          Nouvel enregistrement
        </h2>
        <label className={styles.field}>
          <span className={controls.label}>Titre</span>
          <input
            className={controls.input}
            value={title}
            placeholder="Réunion en présentiel, prise de notes…"
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <fieldset className={styles.fieldset}>
          <legend className={controls.label}>Sources</legend>
          {SOURCE_OPTIONS.map((option) => (
            <label key={option.value} className={styles.radio}>
              <input
                type="radio"
                name="recording-sources"
                value={option.value}
                checked={sources === option.value}
                disabled={!available(option)}
                onChange={() => setSources(option.value)}
              />
              <span>{option.label}</span>
            </label>
          ))}
          {capabilities !== null && !loopbackSupported && (
            <p className={controls.hint}>Le son système n’est disponible que sous Windows.</p>
          )}
          {capabilities !== null && !captureSupported && (
            <p className={controls.hint}>La capture audio n’est pas disponible sur cette plateforme.</p>
          )}
          {sources !== 'system' && <p className={controls.hint}>{ECHO_TIP}</p>}
        </fieldset>
        <label className={styles.field}>
          <span className={controls.label}>Rattacher à (facultatif)</span>
          <select
            className={controls.select}
            value={entityId}
            onChange={(event) => setEntityId(event.target.value)}
          >
            <option value="">Aucune entité</option>
            {entities.map((entity) => (
              <option key={entity.id} value={entity.id}>
                {entity.name}
              </option>
            ))}
          </select>
        </label>
        {active !== null && <ErrorMessage>Un enregistrement est déjà en cours.</ErrorMessage>}
        {!consentOpen && <ErrorMessage>{error}</ErrorMessage>}
        <div className={dialog.actions}>
          <button type="button" className={controls.secondary} onClick={onClose}>
            Annuler
          </button>
          <button
            type="button"
            className={controls.primary}
            disabled={!canContinue || active !== null}
            onClick={() => setConsentOpen(true)}
          >
            Continuer
          </button>
        </div>
      </Dialog>
      {consentOpen && (
        <ConsentDialog busy={busy} error={error} onCancel={() => setConsentOpen(false)} onConfirm={start} />
      )}
    </>
  );
}

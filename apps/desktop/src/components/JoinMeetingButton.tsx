import { useState } from 'react';
import type { Item } from '@regis/shared';
import { invokeCmd } from '../lib/ipc';
import { canJoin, meetingJoinInfo } from '../lib/meeting';
import { startAndJoin } from '../lib/recording';
import { useModuleOn } from '../lib/use-local-modules';
import { useActiveRecording, useRecordingCapabilities } from '../lib/use-recording';
import { ConsentDialog } from './ConsentDialog';
import styles from './JoinMeetingButton.module.css';

export interface JoinMeetingButtonProps {
  event: Item;
}

const UNSUPPORTED_TITLE = 'Enregistrement disponible sous Windows uniquement';
const ALREADY_RECORDING_TITLE = 'Un enregistrement est déjà en cours';

interface RecordAndJoinProps {
  event: Item;
  disabled: boolean;
  onOpenError: (message: string | null) => void;
}

/** « Rejoindre avec enregistrement » : consentement, puis `recording_start` (both), puis `open_meeting`. */
function RecordAndJoinButton({ event, disabled, onOpenError }: RecordAndJoinProps) {
  const [busy, setBusy] = useState(false);
  const [consentOpen, setConsentOpen] = useState(false);
  const [consentError, setConsentError] = useState<string | null>(null);
  const capabilities = useRecordingCapabilities();
  const active = useActiveRecording();

  const closeConsent = () => {
    setConsentOpen(false);
    setConsentError(null);
  };

  const start = (consentText: string) => {
    setBusy(true);
    setConsentError(null);
    startAndJoin(invokeCmd, event, consentText)
      .then((result) => {
        closeConsent();
        onOpenError(result.openError);
      })
      .catch((reason: unknown) => setConsentError(String(reason)))
      .finally(() => setBusy(false));
  };

  const canRecord = capabilities?.captureSupported === true && capabilities.loopbackSupported;
  const title = active !== null ? ALREADY_RECORDING_TITLE : canRecord ? undefined : UNSUPPORTED_TITLE;

  return (
    <>
      <button
        type="button"
        className={styles.recordButton}
        disabled={disabled || busy || !canRecord || active !== null}
        title={title}
        aria-label={`Rejoindre la réunion ${event.title} avec enregistrement`}
        onClick={() => setConsentOpen(true)}
      >
        Rejoindre avec enregistrement
      </button>
      {consentOpen && (
        <ConsentDialog busy={busy} error={consentError} onCancel={closeConsent} onConfirm={start} />
      )}
    </>
  );
}

export function JoinMeetingButton({ event }: JoinMeetingButtonProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const voiceOn = useModuleOn('voice');

  if (!canJoin(event, new Date())) {
    return null;
  }

  const join = () => {
    setBusy(true);
    setError(null);
    invokeCmd('open_meeting', { itemId: event.id })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setBusy(false));
  };

  return (
    <span className={styles.wrap}>
      <span className={styles.buttons}>
        <button
          type="button"
          className={styles.button}
          disabled={busy}
          aria-label={`Rejoindre la réunion ${event.title}`}
          onClick={join}
        >
          Rejoindre
        </button>
        {voiceOn && meetingJoinInfo(event)?.provider === 'teams' && (
          <RecordAndJoinButton event={event} disabled={busy} onOpenError={setError} />
        )}
      </span>
      {error !== null && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
    </span>
  );
}

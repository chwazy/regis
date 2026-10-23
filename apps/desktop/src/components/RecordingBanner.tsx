import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { Recording, RecordingView } from '@regis/shared';
import { errorMessage } from '../lib/format';
import { invokeCmd } from '../lib/ipc';
import { transcriptPath } from '../lib/paths';
import { elapsedSince, formatDuration } from '../lib/recording';
import { useActiveRecording } from '../lib/use-recording';
import styles from './RecordingBanner.module.css';

const TICK_MS = 1000;

/** Bandeau rouge global : visible sur tous les écrans tant qu'une session est en cours. */
export function RecordingBanner() {
  const recording = useActiveRecording();
  return recording === null ? null : <ActiveBanner key={recording.id} recording={recording} />;
}

function ActiveBanner({ recording }: { recording: Recording }) {
  const [now, setNow] = useState(() => Date.now());
  const [transcriptItemId, setTranscriptItemId] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const first = window.setTimeout(() => setNow(Date.now()), 0);
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    invokeCmd<RecordingView>('recording_get', { transcriptItemId: recording.id })
      .then((view) => {
        if (!cancelled) {
          setTranscriptItemId(view.transcriptItemId);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [recording.id]);

  const finalizing = recording.status === 'finalizing';

  const stop = () => {
    setStopping(true);
    setError(null);
    invokeCmd('recording_stop', { id: recording.id })
      .catch((reason: unknown) => setError(errorMessage(reason)))
      .finally(() => setStopping(false));
  };

  return (
    <div role="status" aria-live="polite" className={styles.banner}>
      <span className={styles.dot} aria-hidden="true" />
      <span className={styles.label}>
        {finalizing ? 'Finalisation de la transcription…' : 'Enregistrement en cours'}
      </span>
      <span className={styles.title}>{recording.title}</span>
      <span className={styles.duration}>{formatDuration(elapsedSince(recording.startedAt, now))}</span>
      {transcriptItemId !== null && (
        <Link className={styles.link} to={transcriptPath(transcriptItemId)}>
          Ouvrir la transcription
        </Link>
      )}
      {error !== null && <span className={styles.error}>{error}</span>}
      {!finalizing && (
        <button type="button" className={styles.stop} disabled={stopping} onClick={stop}>
          Arrêter
        </button>
      )}
    </div>
  );
}

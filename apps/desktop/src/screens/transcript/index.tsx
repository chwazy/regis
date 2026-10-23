import { useCallback, useEffect, useState } from 'react';
import { useLocation, useParams, useSearchParams } from 'react-router';
import type { Recording, RecordingView, TranscriptSegment } from '@regis/shared';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import controls from '../../components/ui/controls.module.css';
import { ErrorMessage, Loading } from '../../components/ui/Feedback';
import { PageHeader } from '../../components/ui/PageHeader';
import { StatusPill } from '../../components/ui/StatusPill';
import { Tabs } from '../../components/ui/Tabs';
import { tabPanelProps } from '../../components/ui/tab-panel';
import { errorMessage, formatDateTime } from '../../lib/format';
import { invokeCmd, onRegisEvent } from '../../lib/ipc';
import { ROUTES } from '../../app/routes';
import { entityPath } from '../../lib/paths';
import { useTimezone } from '../../lib/use-timezone';
import { ECHO_TIP, elapsedSince, formatDuration, isSessionLive } from '../../lib/recording';
import {
  SOURCES_LABELS,
  STATUS_TONES,
  appendSegment,
  backlogLabel,
  buildTurns,
  clockLabel,
  estimatedAudioBytes,
  formatBytes,
  levelFraction,
  originEntityId,
  speakerLabel,
  statusLabel,
} from './transcript-view';
import MinutesTab from './MinutesTab';
import styles from './transcript.module.css';

const TICK_MS = 1000;

type Tab = 'transcript' | 'minutes';

const TABS_PREFIX = 'transcript';
const TAB_ITEMS = [
  { id: 'transcript', label: 'Transcription' },
  { id: 'minutes', label: 'PV' },
] as const;

interface Levels {
  mic: number | null;
  system: number | null;
}

interface SegmentEvent {
  recordingId: string;
  segment: TranscriptSegment;
}

interface LevelEvent extends Levels {
  recordingId: string;
}

interface BacklogEvent {
  recordingId: string;
  pendingChunks: number;
}

function Gauge({ label, rms }: { label: string; rms: number | null }) {
  if (rms === null) {
    return null;
  }
  return (
    <div className={styles.gauge}>
      <span className={styles.gaugeLabel}>{label}</span>
      <div
        role="meter"
        aria-label={`Niveau ${label}`}
        aria-valuemin={0}
        aria-valuemax={1}
        aria-valuenow={levelFraction(rms)}
        className={styles.gaugeTrack}
      >
        <div className={styles.gaugeFill} style={{ width: `${Math.round(levelFraction(rms) * 100)}%` }} />
      </div>
    </div>
  );
}

export default function TranscriptScreen() {
  const { itemId = '' } = useParams();
  return <TranscriptView key={itemId} itemId={itemId} />;
}

function TranscriptView({ itemId }: { itemId: string }) {
  const [recording, setRecording] = useState<Recording | null>(null);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [pending, setPending] = useState(0);
  const [levels, setLevels] = useState<Levels>({ mic: null, system: null });
  const timeZone = useTimezone();
  const location = useLocation();
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [stopping, setStopping] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState<Tab>(searchParams.get('tab') === 'minutes' ? 'minutes' : 'transcript');
  const recordingId = recording?.id ?? null;
  const live = isSessionLive(recording);

  const load = useCallback(() => {
    invokeCmd<RecordingView>('recording_get', { transcriptItemId: itemId })
      .then((view) => {
        setRecording(view.recording);
        setSegments(view.segments);
        setPending(view.pendingChunks);
        setError(null);
      })
      .catch((reason: unknown) => setError(errorMessage(reason)));
  }, [itemId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (recordingId === null) {
      return undefined;
    }
    const stops = [
      onRegisEvent<SegmentEvent>('recording.segment', (event) => {
        if (event.payload.recordingId === recordingId) {
          setSegments((current) => appendSegment(current, event.payload.segment));
        }
      }),
      onRegisEvent<Recording>('recording.state', (event) => {
        if (event.payload.id !== recordingId) {
          return;
        }
        setRecording(event.payload);
        if (!isSessionLive(event.payload)) {
          setLevels({ mic: null, system: null });
          load();
        }
      }),
      onRegisEvent<LevelEvent>('recording.level', (event) => {
        if (event.payload.recordingId === recordingId) {
          setLevels({ mic: event.payload.mic, system: event.payload.system });
        }
      }),
      onRegisEvent<BacklogEvent>('recording.backlog', (event) => {
        if (event.payload.recordingId === recordingId) {
          setPending(event.payload.pendingChunks);
        }
      }),
    ];
    return () => {
      for (const stop of stops) {
        void stop.then((unlisten) => unlisten());
      }
    };
  }, [recordingId, load]);

  useEffect(() => {
    if (!live) {
      return undefined;
    }
    const first = window.setTimeout(() => setNow(Date.now()), 0);
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [live]);

  const stop = () => {
    if (recording === null) {
      return;
    }
    setStopping(true);
    invokeCmd('recording_stop', { id: recording.id })
      .catch((reason: unknown) => setError(errorMessage(reason)))
      .finally(() => setStopping(false));
  };

  const deleteAudio = () => {
    if (recording === null) {
      return Promise.resolve();
    }
    return invokeCmd<Recording>('recording_delete_audio', { id: recording.id })
      .then(setRecording)
      .catch((reason: unknown) => setError(errorMessage(reason)));
  };

  const originId = originEntityId(location.state);
  const back =
    originId === null
      ? { to: ROUTES.brain, label: 'Cerveau' }
      : { to: entityPath(originId), label: 'Fiche de l’entité' };

  if (recording === null) {
    return (
      <>
        <PageHeader title="Transcription" back={back} />
        {error !== null ? <ErrorMessage>{error}</ErrorMessage> : <Loading />}
      </>
    );
  }

  const durationMs = recording.durationMs ?? elapsedSince(recording.startedAt, now);
  const turns = buildTurns(segments);
  const backlog = backlogLabel(pending);
  const finished = !live;

  return (
    <>
      <PageHeader
        back={back}
        title={recording.title}
        subtitle={
          <>
            <StatusPill tone={STATUS_TONES[recording.status]} pulse={recording.status === 'recording'}>
              {statusLabel(recording)}
            </StatusPill>
            <span>{formatDateTime(recording.startedAt, timeZone)}</span>
            <span className={styles.mono}>{formatDuration(durationMs)}</span>
            <span>{SOURCES_LABELS[recording.sources]}</span>
          </>
        }
        actions={
          recording.status === 'recording' ? (
            <button type="button" className={controls.dangerSolid} disabled={stopping} onClick={stop}>
              Arrêter
            </button>
          ) : undefined
        }
      />

      <ErrorMessage>{error}</ErrorMessage>
      {recording.error !== null && <p className={styles.warning}>{recording.error}</p>}

      {live && (
        <div className={styles.live}>
          <div className={styles.gauges}>
            <Gauge label="Micro" rms={levels.mic} />
            <Gauge label="Son système" rms={levels.system} />
          </div>
          {backlog !== null && <p className={styles.backlog}>{backlog}</p>}
          {recording.sources === 'both' && <p className={styles.tip}>{ECHO_TIP}</p>}
        </div>
      )}

      <Tabs idPrefix={TABS_PREFIX} label="Contenu" items={TAB_ITEMS} value={tab} onChange={setTab} />

      <div {...tabPanelProps(TABS_PREFIX, 'minutes')} hidden={tab !== 'minutes'}>
        <MinutesTab
          transcriptItemId={itemId}
          status={recording.status}
          onGenerated={() => setTab('minutes')}
        />
      </div>

      <div
        {...tabPanelProps(TABS_PREFIX, 'transcript')}
        hidden={tab !== 'transcript'}
        className={styles.panel}
      >
        <div className={styles.segments} aria-label="Segments" aria-live={live ? 'polite' : 'off'}>
          {turns.length === 0 && (
            <p className={styles.muted}>
              {live ? 'En attente des premières paroles…' : 'Aucun texte transcrit.'}
            </p>
          )}
          {turns.map((turn) => (
            <p key={`${turn.source}-${String(turn.startMs)}`} className={styles.turn}>
              <span className={styles.time}>{clockLabel(turn.startMs)}</span>
              <strong className={turn.source === 'mic' ? styles.speakerMe : styles.speaker}>
                {speakerLabel(turn.source)}
              </strong>
              <span>{turn.text}</span>
            </p>
          ))}
        </div>

        {finished && (
          <footer className={styles.footer}>
            {recording.audioAvailable ? (
              <>
                <span className={styles.muted}>
                  Audio conservé sur le disque (environ{' '}
                  {formatBytes(estimatedAudioBytes(durationMs, recording.sources))}), supprimé automatiquement
                  après la durée de rétention.
                </span>
                <button type="button" className={controls.danger} onClick={() => setConfirmingDelete(true)}>
                  Supprimer l’audio maintenant
                </button>
              </>
            ) : (
              <span className={styles.muted}>Audio supprimé. La transcription est conservée.</span>
            )}
          </footer>
        )}
      </div>

      {confirmingDelete && (
        <ConfirmDialog
          title="Supprimer l’audio maintenant ?"
          confirmLabel="Supprimer l’audio"
          onConfirm={deleteAudio}
          onClose={() => setConfirmingDelete(false)}
        >
          L’enregistrement audio sera effacé du disque. La transcription est conservée. Cette action est
          irréversible.
        </ConfirmDialog>
      )}
    </>
  );
}

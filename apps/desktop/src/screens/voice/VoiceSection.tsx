import { useCallback, useEffect, useState } from 'react';
import type { AudioDevice, AudioSource, ModuleDownloadProgress, SttStatus } from '@regis/shared';
import { ErrorMessage } from '../../components/ui/Feedback';
import { errorMessage } from '../../lib/format';
import { invokeCmd, onRegisEvent } from '../../lib/ipc';
import {
  UNSUPPORTED_CAPTURE_MESSAGE,
  formatMegabytes,
  modelStateLabel,
  progressPercent,
} from './voice-labels';
import styles from './voice.module.css';

const MIC_SETTING = 'audio.micDeviceId';
const LOOPBACK_SETTING = 'audio.loopbackDeviceId';
const TEST_DURATION_MS = 5000;
const MIN_BAR_PERCENT = 4;

interface DeviceSelectProps {
  id: string;
  label: string;
  devices: AudioDevice[];
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}

function DeviceSelect({ id, label, devices, value, disabled, onChange }: DeviceSelectProps) {
  return (
    <div className={styles.field}>
      <label htmlFor={id} className={styles.label}>
        {label}
      </label>
      <select
        id={id}
        className={styles.select}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Périphérique par défaut</option>
        {devices.map((device) => (
          <option key={device.id} value={device.id}>
            {device.name}
            {device.isDefault ? ' (par défaut)' : ''}
          </option>
        ))}
      </select>
    </div>
  );
}

export function VoiceSection() {
  const [status, setStatus] = useState<SttStatus | null>(null);
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [micId, setMicId] = useState('');
  const [loopbackId, setLoopbackId] = useState('');
  const [progress, setProgress] = useState<ModuleDownloadProgress | null>(null);
  const [levels, setLevels] = useState<number[]>([]);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const fail = (reason: unknown) => active && setError(errorMessage(reason));
    invokeCmd<SttStatus>('stt_status')
      .then((loaded) => active && setStatus(loaded))
      .catch(fail);
    invokeCmd<AudioDevice[]>('audio_list_devices')
      .then((loaded) => active && setDevices(loaded))
      .catch(() => undefined);
    invokeCmd<string | null>('get_setting', { key: MIC_SETTING })
      .then((value) => active && setMicId(value ?? ''))
      .catch(() => undefined);
    invokeCmd<string | null>('get_setting', { key: LOOPBACK_SETTING })
      .then((value) => active && setLoopbackId(value ?? ''))
      .catch(() => undefined);
    const unlisten = onRegisEvent<ModuleDownloadProgress>('module.download.progress', (event) => {
      if (active && event.payload.id === 'voice') {
        setProgress(event.payload);
      }
    });
    return () => {
      active = false;
      void unlisten.then((stop) => stop());
    };
  }, []);

  const download = useCallback(async () => {
    if (!status) {
      return;
    }
    setError(null);
    setProgress(null);
    setStatus({ ...status, state: 'downloading', downloadedBytes: 0, error: null });
    try {
      setStatus(await invokeCmd<SttStatus>('stt_download_model', { modelId: status.modelId }));
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setProgress(null);
    }
  }, [status]);

  const saveDevice = async (key: string, value: string, apply: (value: string) => void) => {
    setError(null);
    try {
      await invokeCmd('set_setting', { key, value });
      apply(value);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };

  const testMicrophone = async () => {
    const source: AudioSource = 'microphone';
    setTesting(true);
    setLevels([]);
    setError(null);
    try {
      setLevels(await invokeCmd<number[]>('audio_test_level', { source, durationMs: TEST_DURATION_MS }));
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setTesting(false);
    }
  };

  const captureSupported = status?.captureSupported ?? true;
  const downloading = status?.state === 'downloading';
  const downloaded = progress?.downloadedBytes ?? status?.downloadedBytes ?? null;
  const total = progress?.totalBytes ?? status?.totalBytes ?? null;
  const microphones = devices.filter((device) => device.source === 'microphone');
  const outputs = devices.filter((device) => device.source === 'systemLoopback');

  return (
    <section className={styles.card} aria-labelledby="voice-title">
      <h2 id="voice-title" className={styles.title}>
        Micro, son système et modèle
      </h2>
      <p className={styles.hint}>
        La transcription est faite localement par whisper.cpp : aucun son ne quitte ce PC.
      </p>
      {status && (
        <div className={styles.row}>
          <span className={styles.state}>{modelStateLabel(status.state)}</span>
          <span className={styles.size}>
            {status.modelId} · {formatMegabytes(status.totalBytes)}
          </span>
          {status.state !== 'ready' && (
            <button
              type="button"
              className={styles.primaryButton}
              disabled={downloading}
              onClick={() => void download()}
            >
              {downloading ? 'Téléchargement…' : 'Télécharger'}
            </button>
          )}
        </div>
      )}
      {downloading && (
        <div className={styles.row}>
          <progress
            className={styles.progress}
            aria-label="Progression du téléchargement"
            max={100}
            value={progressPercent(downloaded, total)}
          />
          <span className={styles.size}>
            {formatMegabytes(downloaded)} / {formatMegabytes(total)}
          </span>
        </div>
      )}
      <ErrorMessage>{status?.error}</ErrorMessage>
      {!captureSupported && <p className={styles.hint}>{UNSUPPORTED_CAPTURE_MESSAGE}</p>}
      <div className={styles.row}>
        <DeviceSelect
          id="voice-mic-device"
          label="Microphone"
          devices={microphones}
          value={micId}
          disabled={!captureSupported}
          onChange={(value) => void saveDevice(MIC_SETTING, value, setMicId)}
        />
        <DeviceSelect
          id="voice-loopback-device"
          label="Sortie système (loopback)"
          devices={outputs}
          value={loopbackId}
          disabled={!captureSupported || !(status?.loopbackSupported ?? true)}
          onChange={(value) => void saveDevice(LOOPBACK_SETTING, value, setLoopbackId)}
        />
      </div>
      <div className={styles.row}>
        <button
          type="button"
          className={styles.secondaryButton}
          disabled={testing || !captureSupported}
          onClick={() => void testMicrophone()}
        >
          {testing ? 'Écoute en cours…' : 'Tester le micro (5 s)'}
        </button>
        {levels.length > 0 && (
          <div className={styles.meter} role="img" aria-label="Niveau sonore du micro">
            {levels.map((level, index) => (
              <div
                key={index}
                className={styles.bar}
                style={{ height: `${Math.max(MIN_BAR_PERCENT, Math.min(100, level * 300))}%` }}
              />
            ))}
          </div>
        )}
      </div>
      <ErrorMessage>{error}</ErrorMessage>
    </section>
  );
}

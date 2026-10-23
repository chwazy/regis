import type { CSSProperties } from 'react';
import { formatDuration } from '../lib/recording';
import { useDictation } from '../lib/use-dictation';
import { useModuleOn } from '../lib/use-local-modules';
import styles from './DictationButton.module.css';

export interface DictationButtonProps {
  onText: (text: string) => void;
  disabled?: boolean;
}

function MicIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
    </svg>
  );
}

export function DictationButton(props: DictationButtonProps) {
  const voiceOn = useModuleOn('voice');
  return voiceOn ? <ActiveDictationButton {...props} /> : null;
}

function ActiveDictationButton({ onText, disabled = false }: DictationButtonProps) {
  const { state, elapsedMs, level, error, toggle } = useDictation(onText);
  const listening = state === 'listening';
  const transcribing = state === 'transcribing';
  const unavailable = state === 'unavailable';
  const label = listening ? 'Arrêter la dictée' : transcribing ? 'Transcription en cours' : 'Dicter';
  const classes = [styles.button, listening ? styles.listening : '', transcribing ? styles.busy : '']
    .filter(Boolean)
    .join(' ');
  const title = unavailable ? (error ?? undefined) : listening ? 'Échap pour annuler' : undefined;

  return (
    <span className={styles.wrap}>
      <button
        type="button"
        className={classes}
        style={{ '--level': level } as CSSProperties}
        aria-label={label}
        aria-pressed={listening}
        title={title}
        disabled={disabled || unavailable || transcribing}
        onClick={toggle}
      >
        {transcribing ? <span className={styles.spinner} aria-hidden="true" /> : <MicIcon />}
      </button>
      {listening && (
        <span className={styles.elapsed} role="timer" aria-label="Durée de la dictée">
          {formatDuration(elapsedMs)}
        </span>
      )}
      {state === 'error' && error && (
        <span role="alert" className={styles.error}>
          {error}
        </span>
      )}
    </span>
  );
}

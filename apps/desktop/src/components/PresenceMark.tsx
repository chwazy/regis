import styles from './PresenceMark.module.css';
import { PRESENCE_LABELS, type PresenceState } from './presence-state';

export interface PresenceMarkProps {
  state?: PresenceState;
  size?: number;
}

/** Logo « Présence » de Régis : la couleur du noyau et les anneaux traduisent l'état. */
export function PresenceMark({ state = 'idle', size = 28 }: PresenceMarkProps) {
  const label = PRESENCE_LABELS[state];
  return (
    <svg
      className={`${styles.mark} ${styles[state]}`}
      width={size}
      height={size}
      viewBox="0 0 96 96"
      role="img"
      aria-label={label}
    >
      <title>{label}</title>
      {state === 'listening' && <circle className={styles.halo} cx="48" cy="48" r="45" />}
      <circle className={styles.outer} cx="48" cy="48" r={state === 'listening' ? 39 : 45} />
      <circle className={styles.mid} cx="48" cy="48" r={state === 'listening' ? 28 : 32} />
      <circle className={styles.core} cx="48" cy="48" r={state === 'listening' ? 16 : 18} />
      {state === 'thinking' && <path className={styles.arc} d="M48 3 A45 45 0 0 1 93 48" />}
    </svg>
  );
}

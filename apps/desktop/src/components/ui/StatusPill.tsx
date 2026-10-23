import type { ReactNode } from 'react';
import styles from './pill.module.css';

export type PillTone = 'accent' | 'warn' | 'ok' | 'danger' | 'muted';

interface StatusPillProps {
  tone: PillTone;
  dot?: boolean;
  pulse?: boolean;
  title?: string;
  children: ReactNode;
}

export function StatusPill({ tone, dot = false, pulse = false, title, children }: StatusPillProps) {
  return (
    <span className={styles[tone]} title={title}>
      {(dot || pulse) && <span className={pulse ? styles.pulse : styles.dot} aria-hidden="true" />}
      {children}
    </span>
  );
}

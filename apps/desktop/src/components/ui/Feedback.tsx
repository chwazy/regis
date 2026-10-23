import type { ReactNode } from 'react';
import styles from './page.module.css';

/** Message d'erreur annoncé aux lecteurs d'écran. */
export function ErrorMessage({ children }: { children: ReactNode }) {
  if (children === null || children === undefined || children === false || children === '') {
    return null;
  }
  return (
    <p role="alert" className={styles.error}>
      {children}
    </p>
  );
}

/** État de chargement : à afficher tant qu'aucune donnée n'est arrivée, au lieu d'un faux état vide. */
export function Loading({ label = 'Chargement…' }: { label?: string }) {
  return (
    <p role="status" className={styles.loading}>
      <span className={styles.spinner} aria-hidden="true" />
      {label}
    </p>
  );
}

import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { ErrorMessage, Loading } from '../components/ui/Feedback';
import type { WidgetState } from './use-widget-data';
import styles from './widgets.module.css';

export interface WidgetProps<C> {
  config: C;
  widgetId: string;
}

export type NoConfig = Record<string, never>;

export function Big({ children }: { children: ReactNode }) {
  return <span className={styles.big}>{children}</span>;
}

interface RowProps {
  label: ReactNode;
  value?: ReactNode;
  hint?: string;
  /** Cible de la ligne quand elle existe ; sans cible, la ligne n'est pas un lien. */
  to?: string;
}

export function Row({ label, value, hint, to }: RowProps) {
  const content = (
    <>
      <span className={styles.rowLabel}>{label}</span>
      {value !== undefined && <span className={styles.rowValue}>{value}</span>}
    </>
  );
  return to === undefined ? (
    <div className={styles.row} title={hint}>
      {content}
    </div>
  ) : (
    <Link to={to} className={styles.rowLink} title={hint}>
      {content}
    </Link>
  );
}

export function WidgetError({ message }: { message: string }) {
  return <ErrorMessage>{message}</ErrorMessage>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className={styles.empty}>{children}</p>;
}

export function WidgetData<T>({
  state,
  children,
}: {
  state: WidgetState<T>;
  children: (data: T) => ReactNode;
}) {
  return (
    <>
      {state.error !== null && <WidgetError message={state.error} />}
      {state.data === null && state.error === null && <Loading />}
      {state.data !== null && children(state.data)}
    </>
  );
}

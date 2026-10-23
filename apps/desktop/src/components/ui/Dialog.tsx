import { useEffect, useRef, type ReactNode } from 'react';
import styles from './dialog.module.css';

interface DialogProps {
  labelledBy: string;
  onClose: () => void;
  size?: 'sm' | 'md' | 'lg';
  /** Ferme au clic sur le fond (défaut : oui). */
  dismissible?: boolean;
  children: ReactNode;
}

/**
 * Dialogue modal natif (`<dialog>.showModal()`) : piège du focus, Échap et fond fournis par
 * le navigateur ; le focus revient sur l'élément d'origine à la fermeture.
 */
export function Dialog({ labelledBy, onClose, size = 'md', dismissible = true, children }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const dialog = ref.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dialog && !dialog.open) {
      dialog.showModal();
    }
    return () => {
      dialog?.close();
      opener?.focus();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      aria-labelledby={labelledBy}
      className={styles[size]}
      onCancel={(event) => {
        event.preventDefault();
        onCloseRef.current();
      }}
      onMouseDown={(event) => {
        if (dismissible && event.target === event.currentTarget) {
          onCloseRef.current();
        }
      }}
    >
      <div className={styles.body}>{children}</div>
    </dialog>
  );
}

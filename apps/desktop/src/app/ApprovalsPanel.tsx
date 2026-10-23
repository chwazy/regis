import { useEffect, useRef, useState } from 'react';
import { ApprovalRow } from '../components/ApprovalRow';
import { ErrorMessage } from '../components/ui/Feedback';
import { useApprovalsReview } from './approvals-review';
import styles from './ApprovalsPanel.module.css';

const MAX_ROWS = 5;

export function ApprovalsPanel() {
  const { pending, error, open: openReview } = useApprovalsReview();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const onMouseDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const review = (approvalId?: string) => {
    setOpen(false);
    openReview(approvalId);
  };

  const now = new Date();

  return (
    <div ref={rootRef} className={styles.root}>
      <button
        type="button"
        className={pending.length > 0 ? `${styles.trigger} ${styles.triggerActive}` : styles.trigger}
        aria-expanded={open}
        aria-label={`Validations en attente : ${String(pending.length)}`}
        title="À valider"
        onClick={() => setOpen((current) => !current)}
      >
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
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {pending.length > 0 && (
          <span className={styles.count} aria-hidden="true">
            {pending.length > 99 ? '99+' : pending.length}
          </span>
        )}
      </button>
      {open && (
        <div role="region" aria-label="Validations en attente" className={styles.menu}>
          <div className={styles.menuHead}>
            <h2 className={styles.menuTitle}>À valider</h2>
            {pending.length > 0 && <span className={styles.badge}>{pending.length}</span>}
          </div>
          <ErrorMessage>{error}</ErrorMessage>
          {pending.length === 0 && !error && <p className={styles.empty}>Aucune validation en attente.</p>}
          <div className={styles.rows}>
            {pending.slice(0, MAX_ROWS).map((approval) => (
              <ApprovalRow
                key={approval.id}
                approval={approval}
                now={now}
                compact
                onOpen={() => review(approval.id)}
              />
            ))}
          </div>
          {pending.length > 0 && (
            <button type="button" className={styles.reviewAll} onClick={() => review()}>
              {pending.length > MAX_ROWS ? `Tout examiner (${String(pending.length)}) →` : 'Tout examiner →'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

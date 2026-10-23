import type { Approval } from '@regis/shared';
import controls from './ui/controls.module.css';
import { approvalSummary, readApprovalPreview, waitingSince, type ViewPreview } from './approval-labels';
import styles from './ApprovalRow.module.css';

interface ApprovalRowProps {
  approval: Approval;
  now: Date;
  compact?: boolean;
  onOpen: () => void;
}

function ApprovalIcon({ kind }: { kind: ViewPreview['kind'] }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {kind === 'mail' && (
        <>
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="m3 7 9 6 9-6" />
        </>
      )}
      {kind === 'timesheet' && (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 3" />
        </>
      )}
      {kind === 'file' && (
        <>
          <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
          <path d="M14 3v5h5" />
        </>
      )}
      {kind === 'generic' && (
        <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.5-2.5z" />
      )}
    </svg>
  );
}

/**
 * Ligne de validation unique : `compact` pour le panneau (toute la ligne est un bouton),
 * normale pour les listes (Brief, Agents) avec un bouton « Examiner ».
 */
export function ApprovalRow({ approval, now, compact = false, onOpen }: ApprovalRowProps) {
  const preview = readApprovalPreview(approval);
  const summary = approvalSummary(preview, approval.tool);
  const content = (
    <>
      <span className={styles.icon}>
        <ApprovalIcon kind={preview.kind} />
      </span>
      <span className={styles.text}>
        <span className={styles.action}>{summary.action}</span>
        {summary.detail && <span className={styles.detail}>{summary.detail}</span>}
      </span>
      <span className={styles.since}>{waitingSince(approval.createdAt, now)}</span>
    </>
  );
  if (compact) {
    return (
      <button type="button" className={styles.compact} onClick={onOpen}>
        {content}
      </button>
    );
  }
  return (
    <div className={styles.row}>
      {content}
      <button type="button" className={controls.secondarySm} onClick={onOpen}>
        Examiner
      </button>
    </div>
  );
}

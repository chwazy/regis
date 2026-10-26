import { useEffect, useState } from 'react';
import type { Agent, Approval, Job } from '@regis/shared';
import { ApprovalDetail, type ApprovalOutcome } from '../components/ApprovalCard';
import { approvalHeading, shortToolName, waitingSince } from '../components/approval-labels';
import controls from '../components/ui/controls.module.css';
import { Dialog } from '../components/ui/Dialog';
import dialog from '../components/ui/dialog.module.css';
import { invokeCmd } from '../lib/ipc';
import { ASK_USER_QUESTION_TOOL } from '../components/user-question';
import styles from './ApprovalReviewDialog.module.css';

interface ApprovalReviewDialogProps {
  approval: Approval;
  position: number;
  total: number;
  onPrevious?: () => void;
  onNext?: () => void;
  onResolve: (outcome: ApprovalOutcome) => Promise<void>;
  onClose: () => void;
}

interface JobContext {
  jobId: string;
  label: string;
}

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
}

export function ApprovalReviewDialog({
  approval,
  position,
  total,
  onPrevious,
  onNext,
  onResolve,
  onClose,
}: ApprovalReviewDialogProps) {
  const [context, setContext] = useState<JobContext | null>(null);

  useEffect(() => {
    let active = true;
    Promise.all([invokeCmd<Job>('get_job', { id: approval.jobId }), invokeCmd<Agent[]>('list_agents')])
      .then(([job, agents]) => {
        const agent = agents.find((candidate) => candidate.id === job.agentId);
        if (active) {
          setContext({ jobId: approval.jobId, label: agent ? `${job.title} · ${agent.name}` : job.title });
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [approval.jobId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTyping(event.target)) {
        return;
      }
      if (event.key === 'ArrowLeft' && onPrevious) {
        onPrevious();
      } else if (event.key === 'ArrowRight' && onNext) {
        onNext();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onPrevious, onNext]);

  const jobLabel = context?.jobId === approval.jobId ? context.label : null;

  return (
    <Dialog labelledBy="approval-review-title" onClose={onClose}>
      <div className={dialog.head}>
        <h2 id="approval-review-title" className={`${dialog.title} ${styles.title}`}>
          {approvalHeading(approval)}
        </h2>
        <span className={styles.position}>
          {position} / {total}
        </span>
        <button
          type="button"
          className={controls.iconButton}
          aria-label="Validation précédente"
          disabled={!onPrevious}
          onClick={onPrevious}
        >
          ‹
        </button>
        <button
          type="button"
          className={controls.iconButton}
          aria-label="Validation suivante"
          disabled={!onNext}
          onClick={onNext}
        >
          ›
        </button>
        <button type="button" className={controls.iconButton} aria-label="Fermer" onClick={onClose}>
          ×
        </button>
      </div>
      <p className={styles.meta}>
        {jobLabel ? `${jobLabel} · ` : ''}
        {shortToolName(approval.tool)} · politique : demander · {waitingSince(approval.createdAt, new Date())}
      </p>
      <ApprovalDetail key={approval.id} approval={approval} onResolve={onResolve} shortcuts />
      <p className={styles.hint}>
        {approval.tool === ASK_USER_QUESTION_TOOL
          ? '← → naviguer · Échap fermer'
          : 'A approuver · R rejeter · ← → naviguer · Échap fermer'}
      </p>
    </Dialog>
  );
}

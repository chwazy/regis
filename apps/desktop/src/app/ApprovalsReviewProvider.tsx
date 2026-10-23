import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Approval } from '@regis/shared';
import type { ApprovalOutcome } from '../components/ApprovalCard';
import { errorMessage } from '../lib/format';
import { invokeCmd, onRegisEvent } from '../lib/ipc';
import { ApprovalReviewDialog } from './ApprovalReviewDialog';
import { ApprovalsReviewContext, reviewTarget, type ApprovalsReview } from './approvals-review';

interface ReviewState {
  id: string;
  index: number;
}

export function ApprovalsReviewProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Approval[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<ReviewState | null>(null);

  const reload = useCallback(() => {
    invokeCmd<Approval[]>('list_approvals', { status: 'pending' })
      .then((loaded) => {
        setPending(loaded);
        setLoaded(true);
        setError(null);
        if (loaded.length === 0) {
          setReview(null);
        }
      })
      .catch((reason: unknown) => setError(errorMessage(reason)));
  }, []);

  useEffect(() => {
    reload();
    const unlisteners = [onRegisEvent('approval.created', reload), onRegisEvent('approval.resolved', reload)];
    return () => {
      for (const unlistener of unlisteners) {
        void unlistener.then((stop) => stop());
      }
    };
  }, [reload]);

  const open = useCallback(
    (approvalId?: string) => {
      const id = approvalId ?? pending[0]?.id;
      if (id) {
        setReview({
          id,
          index: Math.max(
            0,
            pending.findIndex((approval) => approval.id === id),
          ),
        });
      }
    },
    [pending],
  );

  const index = review ? reviewTarget(pending, review.id, review.index) : -1;
  const current = index >= 0 ? pending[index] : undefined;

  const goTo = (target: number) => {
    const approval = pending[target];
    if (approval) {
      setReview({ id: approval.id, index: target });
    }
  };

  const resolve = async (approval: Approval, outcome: ApprovalOutcome) => {
    await invokeCmd<Approval>('resolve_approval', {
      id: approval.id,
      status: outcome.status,
      decisionNote: outcome.note ?? null,
      editedInput: outcome.editedInput ?? null,
    });
    reload();
  };

  const value = useMemo<ApprovalsReview>(
    () => ({ pending, loaded, error, open }),
    [pending, loaded, error, open],
  );

  return (
    <ApprovalsReviewContext.Provider value={value}>
      {children}
      {current && (
        <ApprovalReviewDialog
          approval={current}
          position={index + 1}
          total={pending.length}
          onPrevious={index > 0 ? () => goTo(index - 1) : undefined}
          onNext={index < pending.length - 1 ? () => goTo(index + 1) : undefined}
          onResolve={(outcome) => resolve(current, outcome)}
          onClose={() => setReview(null)}
        />
      )}
    </ApprovalsReviewContext.Provider>
  );
}

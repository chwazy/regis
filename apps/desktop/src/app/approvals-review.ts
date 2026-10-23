import { createContext, useContext } from 'react';
import type { Approval } from '@regis/shared';

export interface ApprovalsReview {
  pending: Approval[];
  /** Vrai dès la première liste reçue : distingue « aucune validation » de « pas encore chargé ». */
  loaded: boolean;
  error: string | null;
  open: (approvalId?: string) => void;
}

export const ApprovalsReviewContext = createContext<ApprovalsReview | null>(null);

export function useApprovalsReview(): ApprovalsReview {
  const review = useContext(ApprovalsReviewContext);
  if (!review) {
    throw new Error('useApprovalsReview doit être utilisé sous ApprovalsReviewProvider');
  }
  return review;
}

export function reviewTarget(pending: Approval[], id: string, lastIndex: number): number {
  const found = pending.findIndex((approval) => approval.id === id);
  if (found >= 0) {
    return found;
  }
  return pending.length === 0 ? -1 : Math.min(lastIndex, pending.length - 1);
}

import { isUserQuestion } from '../approvals/questions';
import type { DeferredOutcome } from '../approvals/service';

const MAX_RESULT_LENGTH = 2000;

export function approvalFollowUpMessage(outcome: DeferredOutcome): string {
  if (isUserQuestion(outcome.tool)) {
    return outcome.status !== 'rejected' && outcome.ok
      ? `L’utilisateur a répondu à ta question : ${describe(outcome.result)}. Poursuis avec ces réponses.`
      : 'L’utilisateur n’a pas répondu à ta question. Poursuis sans cette information ou reformule-la.';
  }
  if (outcome.status === 'rejected') {
    const note = outcome.note?.trim();
    return `L’utilisateur a rejeté l’action ${outcome.tool} que tu avais demandée.${note ? ` Consigne : ${note}` : ''} Ne la réessaie pas telle quelle.`;
  }
  if (!outcome.ok) {
    return `L’action ${outcome.tool} a été validée mais son exécution a échoué : ${describe(outcome.result)}`;
  }
  return `L’action ${outcome.tool} que tu avais demandée a été validée et exécutée. Résultat : ${describe(outcome.result)} Poursuis la tâche sans la refaire.`;
}

function describe(result: unknown): string {
  const text = typeof result === 'string' ? result : (JSON.stringify(result) ?? '');
  return text.length <= MAX_RESULT_LENGTH ? text : `${text.slice(0, MAX_RESULT_LENGTH)}…`;
}

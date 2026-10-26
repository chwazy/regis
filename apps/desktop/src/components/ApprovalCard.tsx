import { useEffect, useState } from 'react';
import type { Approval } from '@regis/shared';
import { errorMessage, formatCalendarDay, formatHours } from '../lib/format';
import { ErrorMessage } from './ui/Feedback';
import controls from './ui/controls.module.css';
import {
  approvalHeading,
  parseEditedInput,
  readApprovalPreview,
  shortToolName,
  type ViewPreview,
} from './approval-labels';
import { answeredInput, readUserQuestions, type UserQuestion } from './user-question';
import { UserQuestionForm } from './UserQuestionForm';
import styles from './ApprovalCard.module.css';

export interface ApprovalOutcome {
  status: 'approved' | 'edited' | 'rejected';
  note?: string;
  editedInput?: unknown;
}

interface ApprovalCardProps {
  approval: Approval;
  onResolve: (outcome: ApprovalOutcome) => Promise<void>;
}

interface ApprovalDetailProps extends ApprovalCardProps {
  scrollClassName?: string;
  shortcuts?: boolean;
}

function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
  );
}

type Mode = 'view' | 'edit' | 'reject';

function PreviewBody({ preview }: { preview: ViewPreview }) {
  if (preview.kind === 'mail') {
    return (
      <>
        <div className={styles.meta}>
          <span>À : {preview.to.join(', ') || '—'}</span>
          {preview.cc && preview.cc.length > 0 && <span>Cc : {preview.cc.join(', ')}</span>}
          <span>Objet : {preview.subject}</span>
          {preview.attachments.length > 0 && <span>Pièces jointes : {preview.attachments.join(', ')}</span>}
        </div>
        <p className={styles.body}>{preview.body}</p>
      </>
    );
  }
  if (preview.kind === 'file') {
    return (
      <>
        <div className={styles.meta}>
          <span>
            Fichier : <span className={styles.path}>{preview.path}</span>
          </span>
        </div>
        <pre className={styles.fileContent}>{preview.content}</pre>
      </>
    );
  }
  if (preview.kind === 'timesheet') {
    return (
      <div className={styles.meta}>
        <span>Projet : {preview.project}</span>
        <span>Date : {formatCalendarDay(preview.date)}</span>
        <span>Heures : {formatHours(preview.hours)}</span>
        <span>Description : {preview.description}</span>
      </div>
    );
  }
  return <pre className={styles.json}>{preview.json}</pre>;
}

function QuestionDetail({
  approval,
  questions,
  onResolve,
}: ApprovalCardProps & { questions: UserQuestion[] }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (outcome: ApprovalOutcome) => {
    setBusy(true);
    setError(null);
    try {
      await onResolve(outcome);
    } catch (reason: unknown) {
      setError(errorMessage(reason));
      setBusy(false);
    }
  };

  return (
    <div className={styles.detail}>
      <UserQuestionForm
        questions={questions}
        busy={busy}
        onAnswer={(answers) =>
          void submit({ status: 'edited', editedInput: answeredInput(approval.inputJson, answers) })
        }
        onSkip={() => void submit({ status: 'rejected' })}
      />
      <ErrorMessage>{error}</ErrorMessage>
    </div>
  );
}

export function ApprovalDetail(props: ApprovalDetailProps) {
  const questions = readUserQuestions(props.approval);
  return questions ? (
    <QuestionDetail approval={props.approval} questions={questions} onResolve={props.onResolve} />
  ) : (
    <ActionDetail {...props} />
  );
}

function ActionDetail({ approval, onResolve, scrollClassName, shortcuts = false }: ApprovalDetailProps) {
  const preview = readApprovalPreview(approval);
  const [mode, setMode] = useState<Mode>('view');
  const [editText, setEditText] = useState(() => JSON.stringify(approval.inputJson, null, 2));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (outcome: ApprovalOutcome) => {
    setBusy(true);
    setError(null);
    try {
      await onResolve(outcome);
    } catch (reason: unknown) {
      setError(errorMessage(reason));
      setBusy(false);
    }
  };

  const submitEdit = () => {
    const parsed = parseEditedInput(editText);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    void submit({ status: 'edited', editedInput: parsed.value });
  };

  useEffect(() => {
    if (!shortcuts || mode !== 'view' || busy) {
      return undefined;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target)) {
        return;
      }
      if (event.key === 'a' || event.key === 'A') {
        event.preventDefault();
        void submit({ status: 'approved' });
      } else if (event.key === 'r' || event.key === 'R') {
        event.preventDefault();
        setMode('reject');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  return (
    <div className={styles.detail}>
      <div className={scrollClassName ? `${styles.scroll} ${scrollClassName}` : styles.scroll}>
        <div className={styles.preview}>
          <PreviewBody preview={preview} />
        </div>

        {mode === 'edit' && (
          <div className={styles.field}>
            <label className={controls.label} htmlFor={`edit-${approval.id}`}>
              Arguments de l’appel (JSON)
            </label>
            <textarea
              id={`edit-${approval.id}`}
              className={`${controls.textarea} ${styles.mono}`}
              rows={8}
              autoFocus
              value={editText}
              onChange={(event) => setEditText(event.target.value)}
            />
          </div>
        )}
        {mode === 'reject' && (
          <div className={styles.field}>
            <label className={controls.label} htmlFor={`note-${approval.id}`}>
              Consigne pour l’agent
            </label>
            <textarea
              id={`note-${approval.id}`}
              className={controls.textarea}
              rows={3}
              autoFocus
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
        )}
        <ErrorMessage>{error}</ErrorMessage>
      </div>

      <div className={styles.actions}>
        {mode === 'view' && (
          <>
            <button
              type="button"
              className={controls.primary}
              disabled={busy}
              onClick={() => void submit({ status: 'approved' })}
            >
              Approuver
            </button>
            <button
              type="button"
              className={controls.secondary}
              disabled={busy}
              onClick={() => setMode('edit')}
            >
              Modifier
            </button>
            <button
              type="button"
              className={controls.danger}
              disabled={busy}
              onClick={() => setMode('reject')}
            >
              Rejeter avec consigne…
            </button>
          </>
        )}
        {mode === 'edit' && (
          <>
            <button type="button" className={controls.primary} disabled={busy} onClick={submitEdit}>
              Approuver la version modifiée
            </button>
            <button type="button" className={controls.ghost} disabled={busy} onClick={() => setMode('view')}>
              Annuler
            </button>
          </>
        )}
        {mode === 'reject' && (
          <>
            <button
              type="button"
              className={controls.dangerSolid}
              disabled={busy}
              onClick={() =>
                void submit({ status: 'rejected', ...(note.trim() ? { note: note.trim() } : {}) })
              }
            >
              Rejeter
            </button>
            <button type="button" className={controls.ghost} disabled={busy} onClick={() => setMode('view')}>
              Annuler
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export function ApprovalCard({ approval, onResolve }: ApprovalCardProps) {
  return (
    <section aria-label="Validation requise" className={styles.card}>
      <div className={styles.head}>
        <h2 className={styles.title}>{approvalHeading(approval)}</h2>
        <span className={styles.tool}>{shortToolName(approval.tool)} · politique : demander</span>
      </div>
      <ApprovalDetail approval={approval} onResolve={onResolve} />
    </section>
  );
}

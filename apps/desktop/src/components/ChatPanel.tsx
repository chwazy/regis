import { useCallback, useEffect, useMemo, useState, type SyntheticEvent } from 'react';
import { Link } from 'react-router';
import type { Agent, Job, JobEvent } from '@regis/shared';
import { errorMessage } from '../lib/format';
import { invokeCmd, onRegisEvent, sidecarCall } from '../lib/ipc';
import { jobPath } from '../lib/paths';
import { isActive, mergeEvent } from '../screens/job/job-view';
import { JobStatusPill } from './JobStatusPill';
import { ErrorMessage } from './ui/Feedback';
import { useDictationField } from '../lib/use-dictation';
import { buildChatTimeline } from './chat-messages';
import { DictationButton } from './DictationButton';
import styles from './ChatPanel.module.css';
import controls from './ui/controls.module.css';

interface ChatPanelProps {
  chatJobId?: string | null;
  onChatJobChange?: (chatJobId: string | null) => void;
}

const JOBS_LIMIT = 200;

function SubJobCard({ job }: { job: Job }) {
  const active = isActive(job.status);
  const summary = job.status === 'failed' ? job.error : job.status === 'done' ? job.resultText : null;
  return (
    <div className={styles.subJob}>
      <span className={styles.subJobHead}>
        <span className={styles.subJobTitle}>{job.title}</span>
        <span className={styles.subJobStatus}>
          <JobStatusPill status={job.status} />
          <Link to={jobPath(job.id)} className={styles.subJobOpen}>
            Ouvrir
          </Link>
        </span>
      </span>
      {active && <span className={styles.progress} aria-hidden="true" />}
      {summary && <span className={styles.subJobSummary}>{summary}</span>}
    </div>
  );
}

function ExpandIcon({ expanded }: { expanded: boolean }) {
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
      {expanded ? (
        <>
          <path d="M4 14h6v6" />
          <path d="M20 10h-6V4" />
          <path d="M14 10l7-7" />
          <path d="M3 21l7-7" />
        </>
      ) : (
        <>
          <path d="M15 3h6v6" />
          <path d="M9 21H3v-6" />
          <path d="M21 3l-7 7" />
          <path d="M3 21l7-7" />
        </>
      )}
    </svg>
  );
}

export function ChatPanel({ chatJobId = null, onChatJobChange }: ChatPanelProps) {
  const [currentId, setCurrentId] = useState<string | null>(chatJobId);
  const [chat, setChat] = useState<Job | null>(null);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { ref: fieldRef, remember, onText: insertText } = useDictationField(draft, setDraft);

  const reportError = useCallback((reason: unknown) => setError(errorMessage(reason)), []);

  const reloadJobs = useCallback(() => {
    invokeCmd<Job[]>('list_jobs', { limit: JOBS_LIMIT }).then(setJobs).catch(reportError);
  }, [reportError]);

  useEffect(() => {
    invokeCmd<Agent[]>('list_agents').then(setAgents).catch(reportError);
  }, [reportError]);

  useEffect(() => {
    if (currentId === null) {
      return;
    }
    invokeCmd<Job>('get_job', { id: currentId }).then(setChat).catch(reportError);
    invokeCmd<JobEvent[]>('list_job_events', { jobId: currentId })
      .then((loaded) => setEvents((existing) => loaded.reduce(mergeEvent, existing)))
      .catch(reportError);
    reloadJobs();
    const unlisteners = [
      onRegisEvent<JobEvent>('job.event', (event) => {
        if (event.payload.jobId === currentId) {
          setEvents((existing) => mergeEvent(existing, event.payload));
        }
      }),
      onRegisEvent<Job>('job.updated', (event) => {
        if (event.payload.id === currentId) {
          setChat(event.payload);
        }
        reloadJobs();
      }),
    ];
    return () => {
      for (const unlistener of unlisteners) {
        void unlistener.then((stop) => stop());
      }
    };
  }, [currentId, reloadJobs, reportError]);

  useEffect(() => {
    if (!expanded) {
      return undefined;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !document.querySelector('[role="dialog"]')) {
        setExpanded(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [expanded]);

  const timeline = useMemo(() => (chat ? buildChatTimeline(chat, events, jobs) : []), [chat, events, jobs]);
  const busy = chat !== null && isActive(chat.status);
  const chatAgent = chat ? agents.find((agent) => agent.id === chat.agentId) : undefined;

  const send = (event: SyntheticEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (text === '' || sending) {
      return;
    }
    setSending(true);
    setError(null);
    sidecarCall<Job>('chat.send', { text, ...(currentId === null ? {} : { chatJobId: currentId }) })
      .then((job) => {
        setDraft('');
        if (currentId === null) {
          setCurrentId(job.id);
          onChatJobChange?.(job.id);
        }
      })
      .catch(reportError)
      .finally(() => setSending(false));
  };

  return (
    <section
      aria-label="Assistant"
      className={expanded ? `${styles.panel} ${styles.expanded}` : styles.panel}
    >
      <div className={styles.head}>
        <h2 className={styles.title}>Assistant</h2>
        {chatAgent && (
          <span className={styles.agent}>
            {chatAgent.name}
            {chatAgent.model ? ` · ${chatAgent.model}` : ''}
            {chatAgent.isLocalOnly ? ' · local' : ''}
          </span>
        )}
        <button
          type="button"
          className={`${controls.ghostSm} ${styles.clear}`}
          disabled={currentId === null || sending}
          title="Fermer cette conversation et en démarrer une nouvelle"
          onClick={() => onChatJobChange?.(null)}
        >
          Nouvelle session
        </button>
        <button
          type="button"
          className={styles.expand}
          aria-label={expanded ? 'Réduire l’assistant' : 'Afficher l’assistant en plein écran'}
          aria-pressed={expanded}
          title={expanded ? 'Réduire' : 'Plein écran'}
          onClick={() => setExpanded((current) => !current)}
        >
          <ExpandIcon expanded={expanded} />
        </button>
      </div>
      <ul className={styles.log} aria-live="polite">
        {currentId === null && (
          <li className={styles.hint}>Décris ce que tu veux faire : l’orchestrateur délègue aux agents.</li>
        )}
        {timeline.map((item) =>
          item.kind === 'message' ? (
            <li
              key={item.key}
              className={`${styles.message} ${item.message.role === 'user' ? styles.user : styles.assistant}`}
            >
              {item.message.text}
            </li>
          ) : (
            <li key={item.key} className={styles.subJobItem}>
              <SubJobCard job={item.job} />
            </li>
          ),
        )}
        {busy && <li className={styles.hint}>L’orchestrateur travaille…</li>}
        {chat?.status === 'failed' && chat.error && (
          <li className={styles.jobError}>
            <ErrorMessage>{chat.error}</ErrorMessage>
          </li>
        )}
      </ul>
      {error && (
        <div className={styles.error}>
          <ErrorMessage>{error}</ErrorMessage>
        </div>
      )}
      <form className={styles.form} onSubmit={send}>
        <label htmlFor="chat-draft" className="sr-only">
          Message à l’assistant
        </label>
        <textarea
          id="chat-draft"
          ref={fieldRef}
          className={styles.input}
          rows={3}
          placeholder="Demande, délègue, briefe…"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              send(event);
            }
          }}
        />
        <div className={styles.actions}>
          <span className={styles.hint}>Ctrl+Entrée</span>
          <span className={styles.dictation} onMouseDownCapture={remember}>
            <DictationButton onText={insertText} disabled={sending} />
          </span>
          <button type="submit" className={controls.primarySm} disabled={sending || draft.trim() === ''}>
            Envoyer
          </button>
        </div>
      </form>
    </section>
  );
}

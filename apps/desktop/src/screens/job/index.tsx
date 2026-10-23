import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import type { Agent, Approval, Entity, Job, JobEvent } from '@regis/shared';
import { ROUTES } from '../../app/routes';
import { ApprovalCard, type ApprovalOutcome } from '../../components/ApprovalCard';
import { JobStatusPill } from '../../components/JobStatusPill';
import controls from '../../components/ui/controls.module.css';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { ErrorMessage, Loading } from '../../components/ui/Feedback';
import { PageHeader } from '../../components/ui/PageHeader';
import { errorMessage, formatDateTime, formatTokens, formatUsd } from '../../lib/format';
import { invokeCmd, onRegisEvent, sidecarCall } from '../../lib/ipc';
import { jobPath } from '../../lib/paths';
import { useNow } from '../../lib/use-now';
import { useTimezone } from '../../lib/use-timezone';
import { modeLabel } from '../agent-settings/agent-labels';
import { JobTimeline } from './JobTimeline';
import { TerminalPane } from './TerminalPane';
import { JobTree } from './JobTree';
import { buildJobTree } from './job-tree';
import {
  describeContextRef,
  formatDuration,
  isActive,
  jobKindLabel,
  mergeEvent,
  readStartInfo,
} from './job-view';
import styles from './job.module.css';

const CLOCK_TICK_MS = 30_000;
const TREE_LIMIT = 200;
const RESUMABLE_TERMINAL_STATUSES: Job['status'][] = ['done', 'waiting_approval'];

interface CleanupResult {
  removed: boolean;
  reason?: string;
}

function useJobScreenData(jobId: string | undefined) {
  const [job, setJob] = useState<Job | null>(null);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [entities, setEntities] = useState<Entity[]>([]);
  const [pending, setPending] = useState<Approval[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reloadJobs = useCallback(() => {
    invokeCmd<Job[]>('list_jobs', { limit: TREE_LIMIT })
      .then(setJobs)
      .catch((reason: unknown) => setError(errorMessage(reason)));
  }, []);

  const reloadJob = useCallback(() => {
    if (jobId === undefined) {
      return;
    }
    invokeCmd<Job>('get_job', { id: jobId })
      .then((loaded) => {
        setJob(loaded);
        setError(null);
      })
      .catch((reason: unknown) => setError(errorMessage(reason)));
  }, [jobId]);

  const reloadEvents = useCallback(() => {
    if (jobId === undefined) {
      return;
    }
    invokeCmd<JobEvent[]>('list_job_events', { jobId })
      .then((loaded) => setEvents((current) => loaded.reduce(mergeEvent, current)))
      .catch((reason: unknown) => setError(errorMessage(reason)));
  }, [jobId]);

  const reloadApprovals = useCallback(() => {
    invokeCmd<Approval[]>('list_approvals', { status: 'pending' })
      .then((loaded) => setPending(loaded.filter((approval) => approval.jobId === jobId)))
      .catch((reason: unknown) => setError(errorMessage(reason)));
  }, [jobId]);

  useEffect(() => {
    reloadJob();
    reloadEvents();
    reloadApprovals();
    reloadJobs();
    invokeCmd<Agent[]>('list_agents')
      .then(setAgents)
      .catch((reason: unknown) => setError(errorMessage(reason)));
    invokeCmd<Entity[]>('list_linkable_entities')
      .then(setEntities)
      .catch(() => undefined);
  }, [reloadJob, reloadEvents, reloadApprovals, reloadJobs]);

  useEffect(() => {
    const unlisteners = [
      onRegisEvent<JobEvent>('job.event', (event) => {
        if (event.payload.jobId === jobId) {
          setEvents((current) => mergeEvent(current, event.payload));
        }
      }),
      onRegisEvent<Job>('job.updated', (event) => {
        reloadJobs();
        if (event.payload.id === jobId) {
          setJob(event.payload);
          reloadApprovals();
        }
      }),
      onRegisEvent('approval.created', reloadApprovals),
      onRegisEvent('approval.resolved', reloadApprovals),
    ];
    return () => {
      for (const unlistener of unlisteners) {
        void unlistener.then((stop) => stop());
      }
    };
  }, [jobId, reloadJobs, reloadApprovals]);

  return { job, events, jobs, agents, entities, pending, error, reloadApprovals };
}

export default function JobScreen() {
  const { jobId } = useParams();
  return <JobView key={jobId} jobId={jobId} />;
}

function JobView({ jobId }: { jobId: string | undefined }) {
  const { job, events, jobs, agents, entities, pending, error, reloadApprovals } = useJobScreenData(jobId);
  const timezone = useTimezone();
  const now = useNow(CLOCK_TICK_MS).getTime();
  const [actionError, setActionError] = useState<string | null>(null);
  const [cleanupMessage, setCleanupMessage] = useState<string | null>(null);
  const [terminal, setTerminal] = useState<{ resume: boolean } | null>(null);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const autoOpened = useRef(false);

  const treeNodes = useMemo(() => buildJobTree(jobs, jobId), [jobs, jobId]);
  const startInfo = useMemo(() => readStartInfo(events), [events]);
  const parent = job?.parentId ? jobs.find((candidate) => candidate.id === job.parentId) : undefined;
  const agent = job ? agents.find((candidate) => candidate.id === job.agentId) : undefined;

  const wantsTerminalAtStart = job?.status === 'running' && agent?.mode === 'pty';
  useEffect(() => {
    if (wantsTerminalAtStart && !autoOpened.current) {
      autoOpened.current = true;
      setTerminal((current) => current ?? { resume: false });
    }
  }, [wantsTerminalAtStart]);

  const canTakeOver =
    job !== null &&
    terminal === null &&
    agent?.runtime === 'claude-cli' &&
    job.sessionId !== null &&
    RESUMABLE_TERMINAL_STATUSES.includes(job.status);
  const takeOverTitle =
    job?.status === 'running'
      ? 'Indisponible tant que la tâche tourne'
      : 'Reprendre la session dans un terminal';

  const resolveApproval = async (approval: Approval, outcome: ApprovalOutcome) => {
    await invokeCmd<Approval>('resolve_approval', {
      id: approval.id,
      status: outcome.status,
      decisionNote: outcome.note ?? null,
      editedInput: outcome.editedInput ?? null,
    });
    reloadApprovals();
  };

  const cancelJob = async (): Promise<void> => {
    if (!job) {
      return;
    }
    setActionError(null);
    try {
      await sidecarCall('jobs.cancel', { jobId: job.id });
    } catch (reason: unknown) {
      setActionError(errorMessage(reason));
    }
  };

  const cleanup = () => {
    if (!job) {
      return;
    }
    setActionError(null);
    setCleanupMessage(null);
    sidecarCall<CleanupResult>('jobs.cleanup', { jobId: job.id })
      .then((result) =>
        setCleanupMessage(result.removed ? 'Worktree supprimé.' : (result.reason ?? 'Worktree conservé.')),
      )
      .catch((reason: unknown) => setActionError(errorMessage(reason)));
  };

  const meta: { key: string; value: string }[] = job
    ? [
        { key: 'Agent', value: agent?.name ?? job.agentId },
        { key: 'Mode', value: agent ? modeLabel(agent.mode) : '—' },
        { key: 'Routage', value: job.routingReason ?? '—' },
        { key: 'Modèle', value: startInfo.model ?? agent?.model ?? '—' },
        { key: 'Tâche parente', value: parent?.title ?? '—' },
        { key: 'Worktree git', value: startInfo.worktree?.branch ?? '—' },
        { key: 'Session CLI', value: job.sessionId ? 'reprenable' : '—' },
        {
          key: 'Tokens',
          value: `entrée ${formatTokens(job.tokensIn)} · sortie ${formatTokens(job.tokensOut)}`,
        },
        { key: 'Coût estimé', value: formatUsd(job.costUsd) },
      ]
    : [];

  if (!job) {
    return (
      <div className={styles.page}>
        <PageHeader title="Tâche" back={{ to: ROUTES.agents, label: 'Agents' }} />
        <ErrorMessage>{error}</ErrorMessage>
        {!error && <Loading />}
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <PageHeader
        back={{ to: ROUTES.agents, label: 'Agents' }}
        eyebrow={
          <>
            {jobKindLabel(job)}
            {parent && (
              <>
                {' · de '}
                <Link to={jobPath(parent.id)}>{parent.title}</Link>
              </>
            )}
          </>
        }
        title={job.title}
        subtitle={
          <>
            <JobStatusPill status={job.status} />
            {job.startedAt && (
              <span>
                démarrée le {formatDateTime(job.startedAt, timezone)} ·{' '}
                {formatDuration(job.startedAt, job.endedAt, now)}
              </span>
            )}
          </>
        }
        actions={
          <>
            <button
              type="button"
              className={controls.secondary}
              disabled={!canTakeOver}
              title={takeOverTitle}
              onClick={() => {
                autoOpened.current = true;
                setTerminal({ resume: true });
              }}
            >
              Reprendre la main (terminal)
            </button>
            <button
              type="button"
              className={controls.danger}
              disabled={!isActive(job.status)}
              onClick={() => setConfirmingCancel(true)}
            >
              Annuler la tâche
            </button>
          </>
        }
      />

      <div className={styles.layout}>
        <JobTree nodes={treeNodes} currentId={jobId} agents={agents} />

        <div className={styles.main}>
          <ErrorMessage>{error}</ErrorMessage>
          <ErrorMessage>{actionError}</ErrorMessage>
          {job.error && <ErrorMessage>{`Erreur : ${job.error}`}</ErrorMessage>}

          {pending.map((approval) => (
            <ApprovalCard
              key={approval.id}
              approval={approval}
              onResolve={(outcome) => resolveApproval(approval, outcome)}
            />
          ))}

          {job.resultText && job.status === 'done' && (
            <section aria-label="Résultat" className={styles.card}>
              <h2 className={styles.cardTitle}>Résultat</h2>
              <p className={styles.resultText}>{job.resultText}</p>
            </section>
          )}

          {terminal && (
            <TerminalPane jobId={job.id} resume={terminal.resume} onEnded={() => setTerminal(null)} />
          )}

          {!(terminal && agent?.mode === 'pty') && <JobTimeline events={events} />}
        </div>

        <aside aria-label="Métadonnées" className={styles.side}>
          <section className={styles.card}>
            <h2 className={styles.cardTitle}>Tâche</h2>
            {meta.map((entry) => (
              <div key={entry.key} className={styles.metaRow}>
                <span className={styles.muted}>{entry.key}</span>
                <span className={styles.metaValue}>{entry.value}</span>
              </div>
            ))}
            {startInfo.worktree && (
              <>
                <button type="button" className={controls.secondary} onClick={cleanup}>
                  Nettoyer le worktree
                </button>
                {cleanupMessage && <p className={styles.muted}>{cleanupMessage}</p>}
              </>
            )}
          </section>
          <section aria-label="Références jointes" className={styles.card}>
            <h2 className={styles.cardTitle}>Références jointes</h2>
            {startInfo.contextRefs.length === 0 && <p className={styles.muted}>Aucune référence jointe.</p>}
            {startInfo.contextRefs.map((reference) => {
              const view = describeContextRef(reference, entities);
              return (
                <div key={`${reference.type}:${reference.id}`} className={styles.contextRow}>
                  <span className={styles.contextKind}>{view.kindLabel}</span>
                  {view.to !== null && view.name !== null ? (
                    <Link to={view.to} className={controls.link}>
                      {view.name}
                    </Link>
                  ) : (
                    view.name !== null && <span>{view.name}</span>
                  )}
                </div>
              );
            })}
          </section>
        </aside>
      </div>

      {confirmingCancel && (
        <ConfirmDialog
          title="Annuler la tâche ?"
          confirmLabel="Annuler la tâche"
          onConfirm={cancelJob}
          onClose={() => setConfirmingCancel(false)}
        >
          « {job.title} » sera interrompue.
        </ConfirmDialog>
      )}
    </div>
  );
}

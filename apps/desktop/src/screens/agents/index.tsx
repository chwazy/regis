import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { Agent, Job, JobEvent } from '@regis/shared';
import { useApprovalsReview } from '../../app/approvals-review';
import { ROUTES } from '../../app/routes';
import controls from '../../components/ui/controls.module.css';
import { ErrorMessage, Loading } from '../../components/ui/Feedback';
import { PageHeader } from '../../components/ui/PageHeader';
import { errorMessage, formatTokens, formatUsd } from '../../lib/format';
import { invokeCmd, onRegisEvent, sidecarCall } from '../../lib/ipc';
import { jobPath } from '../../lib/paths';
import { useNow } from '../../lib/use-now';
import { useTimezone } from '../../lib/use-timezone';
import { isActive } from '../job/job-view';
import {
  activeJobRows,
  activityKpis,
  finishedToday,
  lastToolActivity,
  taskTitle,
  waitingMinutes,
  watchList,
  type DetectResult,
  type ToolActivity,
} from './activity';
import styles from './activity.module.css';
import { ActiveJobsCard, AgentsCard, ApprovalsCard, WatchCard } from './ActivitySections';
import { HistoryCard } from './HistorySection';

const JOBS_LIMIT = 200;
const TICK_MS = 5_000;

function upsertJob(jobs: Job[], incoming: Job): Job[] {
  const index = jobs.findIndex((job) => job.id === incoming.id);
  if (index < 0) {
    return [incoming, ...jobs];
  }
  return jobs.map((job) => (job.id === incoming.id ? incoming : job));
}

function useActivityData() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [detect, setDetect] = useState<DetectResult | null>(null);
  const [tools, setTools] = useState<Record<string, ToolActivity | undefined>>({});
  const [error, setError] = useState<string | null>(null);
  const loadedTools = useRef(new Set<string>());

  const loadTool = useCallback((jobId: string) => {
    loadedTools.current.add(jobId);
    invokeCmd<JobEvent[]>('list_job_events', { jobId })
      .then((events) => {
        const tool = lastToolActivity(events);
        if (tool) {
          setTools((current) => ({ ...current, [jobId]: tool }));
        }
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    let active = true;
    Promise.all([invokeCmd<Job[]>('list_jobs', { limit: JOBS_LIMIT }), invokeCmd<Agent[]>('list_agents')])
      .then(([loadedJobs, loadedAgents]) => {
        if (!active) {
          return;
        }
        setJobs(loadedJobs);
        setAgents(loadedAgents);
        setLoaded(true);
        for (const job of loadedJobs.filter((entry) => isActive(entry.status))) {
          loadTool(job.id);
        }
      })
      .catch((reason: unknown) => active && setError(errorMessage(reason)));
    sidecarCall<DetectResult>('agents.detect', {})
      .then((result) => active && setDetect(result))
      .catch(() => active && setDetect({}));

    const unlisteners = [
      onRegisEvent<Job>('job.updated', ({ payload: job }) => {
        setJobs((current) => upsertJob(current, job));
        if (isActive(job.status) && !loadedTools.current.has(job.id)) {
          loadTool(job.id);
        }
      }),
      onRegisEvent<JobEvent>('job.event', ({ payload: event }) => {
        const tool = lastToolActivity([event]);
        if (tool) {
          setTools((current) => ({ ...current, [event.jobId]: tool }));
        }
      }),
    ];
    return () => {
      active = false;
      for (const unlistener of unlisteners) {
        void unlistener.then((stop) => stop());
      }
    };
  }, [loadTool]);

  return { jobs, agents, loaded, detect, tools, error, setError };
}

export default function AgentsScreen() {
  const { jobs, agents, loaded, detect, tools, error, setError } = useActivityData();
  const timezone = useTimezone();
  const { pending, loaded: approvalsLoaded, open: openReview } = useApprovalsReview();
  const navigate = useNavigate();
  const now = useNow(TICK_MS);
  const [composing, setComposing] = useState(false);
  const [description, setDescription] = useState('');
  const [starting, setStarting] = useState(false);

  const agentsById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const jobsById = useMemo(() => new Map(jobs.map((job) => [job.id, job])), [jobs]);
  const pendingByJob = useMemo(
    () => new Map(pending.map((approval) => [approval.jobId, approval])),
    [pending],
  );
  const kpis = activityKpis(jobs, now, timezone);
  const oldestWait = waitingMinutes(pending, now);

  const cancel = async (job: Job): Promise<void> => {
    try {
      await sidecarCall('jobs.cancel', { jobId: job.id });
    } catch (reason: unknown) {
      setError(errorMessage(reason));
    }
  };

  const startTask = () => {
    const prompt = description.trim();
    if (prompt === '') {
      return;
    }
    setStarting(true);
    sidecarCall<Job>('jobs.start', { title: taskTitle(prompt), prompt, kind: 'task', source: 'agents' })
      .then((job) => navigate(jobPath(job.id)))
      .catch((reason: unknown) => setError(errorMessage(reason)))
      .finally(() => setStarting(false));
  };

  return (
    <div className={styles.page}>
      <PageHeader
        title="Agents"
        subtitle="Ce qui tourne, ce qui attend ta décision, ce que ça coûte aujourd’hui."
        actions={
          <>
            <Link to={ROUTES.agentSettings} className={controls.secondary}>
              Configurer les agents
            </Link>
            <button
              type="button"
              className={controls.primary}
              onClick={() => setComposing((current) => !current)}
            >
              + Nouvelle tâche
            </button>
          </>
        }
      />

      {composing && (
        <section aria-label="Nouvelle tâche" className={styles.newTask}>
          <label htmlFor="new-task" className={controls.label}>
            Décris la tâche
          </label>
          <textarea
            id="new-task"
            className={controls.textarea}
            rows={3}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
          <div className={styles.row}>
            <span className={controls.hint}>
              L’orchestrateur choisit l’agent d’après les règles de routage.
            </span>
            <span className={styles.spacer} />
            <button type="button" className={controls.secondary} onClick={() => setComposing(false)}>
              Fermer
            </button>
            <button
              type="button"
              className={controls.primary}
              disabled={starting || description.trim() === ''}
              onClick={startTask}
            >
              Lancer
            </button>
          </div>
        </section>
      )}

      <ErrorMessage>{error}</ErrorMessage>

      {!(loaded && approvalsLoaded) && !error && <Loading />}

      {loaded && approvalsLoaded && (
        <>
          <div className={styles.kpis}>
            <div className={styles.kpi}>
              <span className={styles.kpiLabel}>En cours</span>
              <span className={styles.kpiValue}>{kpis.active}</span>
              <span className={styles.kpiHint}>
                {kpis.subAgents > 0
                  ? `dont ${String(kpis.subAgents)} sous-tâche${kpis.subAgents > 1 ? 's' : ''}`
                  : ' '}
              </span>
            </div>
            <div className={pending.length > 0 ? styles.kpiAlert : styles.kpi}>
              <span className={styles.kpiLabel}>À valider</span>
              <span className={styles.kpiValue}>{pending.length}</span>
              <span className={styles.kpiHint}>
                {oldestWait === null ? ' ' : `plus ancienne : ${String(oldestWait)} min`}
              </span>
            </div>
            <div className={styles.kpi}>
              <span className={styles.kpiLabel}>Coût aujourd’hui</span>
              <span className={`${styles.kpiValue} ${styles.mono}`}>{formatUsd(kpis.costTodayUsd)}</span>
              <span className={styles.kpiHint}>
                estimation locale · {formatTokens(kpis.tokensToday)} tokens
              </span>
            </div>
            <div className={styles.kpi}>
              <span className={styles.kpiLabel}>Terminées aujourd’hui</span>
              <span className={styles.kpiValue}>{kpis.doneToday}</span>
              <span className={styles.kpiHint}>
                {kpis.failedToday} échec{kpis.failedToday > 1 ? 's' : ''} · {kpis.cancelledToday} annulée
                {kpis.cancelledToday > 1 ? 's' : ''}
              </span>
            </div>
          </div>

          <div className={styles.grid}>
            <div className={styles.mainColumn}>
              <ApprovalsCard pending={pending} jobs={jobsById} now={now} onReview={openReview} />
              <ActiveJobsCard
                rows={activeJobRows(jobs)}
                agents={agentsById}
                tools={tools}
                pendingByJob={pendingByJob}
                now={now}
                onReview={openReview}
                onCancel={cancel}
              />
            </div>
            <aside className={styles.sideColumn}>
              <AgentsCard agents={agents} jobs={jobs} detect={detect} now={now} timezone={timezone} />
              <HistoryCard
                jobs={finishedToday(jobs, now, timezone)}
                agents={agentsById}
                now={now}
                timezone={timezone}
              />
              <WatchCard items={watchList(agents, jobs, detect, now, timezone)} />
            </aside>
          </div>
        </>
      )}
    </div>
  );
}

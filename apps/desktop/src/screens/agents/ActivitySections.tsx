import { useState } from 'react';
import { Link } from 'react-router';
import type { Agent, Approval, Job } from '@regis/shared';
import { ROUTES } from '../../app/routes';
import { approvalSummary, readPreview, shortToolName, waitingSince } from '../../components/approval-labels';
import { JobStatusPill } from '../../components/JobStatusPill';
import card from '../../components/ui/card.module.css';
import { CollapseButton } from '../../components/ui/CollapseButton';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import controls from '../../components/ui/controls.module.css';
import { StatusPill } from '../../components/ui/StatusPill';
import { formatClock, formatTokens, formatUsd } from '../../lib/format';
import { jobPath } from '../../lib/paths';
import { useCollapsed } from '../../lib/use-collapsed';
import { capitalize } from '../agent-settings/agent-labels';
import { formatDuration } from '../job/job-view';
import {
  agentActivity,
  agentState,
  budgetLine,
  budgetRatio,
  BUDGET_WARN_RATIO,
  jobCost,
  runtimeSummary,
  secondsAgo,
  type ActiveJobRow,
  type DetectResult,
  type ToolActivity,
  type WatchItem,
} from './activity';
import styles from './activity.module.css';

const APPROVALS_LIST_ID = 'agents-approvals-list';
const ACTIVE_COLLAPSED_KEY = 'agents.active.collapsed';
const ACTIVE_LIST_ID = 'agents-active-list';

const PREVIEW_LABELS = { mail: 'Mail', timesheet: 'Heures', generic: 'Outil' } as const;

interface ApprovalsCardProps {
  pending: Approval[];
  jobs: Map<string, Job>;
  now: Date;
  onReview: (approvalId?: string) => void;
}

export function ApprovalsCard({ pending, jobs, now, onReview }: ApprovalsCardProps) {
  // Toujours replié à l'ouverture de l'écran, sans mémoriser l'état.
  const [collapsed, setCollapsed] = useState(true);
  const toggle = () => setCollapsed((current) => !current);

  return (
    <section aria-label="Validations en attente" className={card.card}>
      <div className={card.toggleHead}>
        <h2 className={card.title}>À valider</h2>
        <span className={card.count}>{pending.length}</span>
        <div className={card.right}>
          {pending.length > 0 && (
            <button type="button" className={controls.secondarySm} onClick={() => onReview()}>
              Tout examiner
            </button>
          )}
          <CollapseButton
            collapsed={collapsed}
            controls={APPROVALS_LIST_ID}
            label="les validations"
            onToggle={toggle}
          />
        </div>
      </div>
      <div id={APPROVALS_LIST_ID} data-collapsed={collapsed ? '' : undefined}>
        {pending.length === 0 && <p className={card.empty}>Aucune validation en attente.</p>}
        {pending.map((approval) => {
          const preview = readPreview(approval.previewJson);
          const summary = approvalSummary(preview, approval.tool);
          const job = jobs.get(approval.jobId);
          return (
            <div key={approval.id} className={styles.approval}>
              <StatusPill tone="warn" dot>
                {PREVIEW_LABELS[preview.kind]}
              </StatusPill>
              <div className={styles.approvalText}>
                <span className={styles.strong}>{summary.action}</span>
                <span className={`${styles.meta} ${styles.ellipsis}`}>
                  <span className={styles.mono}>{shortToolName(approval.tool)}</span>
                  {job && <span>demandé par « {job.title} »</span>}
                  <span>{waitingSince(approval.createdAt, now)}</span>
                </span>
              </div>
              <button type="button" className={controls.primarySm} onClick={() => onReview(approval.id)}>
                Examiner
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

interface ActiveJobsCardProps {
  rows: ActiveJobRow[];
  agents: Map<string, Agent>;
  tools: Record<string, ToolActivity | undefined>;
  pendingByJob: Map<string, Approval>;
  now: Date;
  onReview: (approvalId: string) => void;
  onCancel: (job: Job) => Promise<void>;
}

export function ActiveJobsCard({
  rows,
  agents,
  tools,
  pendingByJob,
  now,
  onReview,
  onCancel,
}: ActiveJobsCardProps) {
  const [agentFilter, setAgentFilter] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<Job | null>(null);
  const [collapsed, toggle] = useCollapsed(ACTIVE_COLLAPSED_KEY);
  const agentIds = [...new Set(rows.map((row) => row.job.agentId))];
  const visible = agentFilter === null ? rows : rows.filter((row) => row.job.agentId === agentFilter);

  return (
    <section aria-label="Tâches en cours" className={card.card}>
      <div className={card.toggleHead}>
        <h2 className={card.title}>En cours</h2>
        <span className={card.count}>{rows.length}</span>
        <div className={card.right}>
          {agentIds.length > 1 && (
            <div className={styles.filterGroup} role="group" aria-label="Filtrer par agent">
              <button
                type="button"
                className={agentFilter === null ? controls.chipOn : controls.chip}
                aria-pressed={agentFilter === null}
                onClick={() => setAgentFilter(null)}
              >
                Tous
              </button>
              {agentIds.map((agentId) => (
                <button
                  key={agentId}
                  type="button"
                  className={agentFilter === agentId ? controls.chipOn : controls.chip}
                  aria-pressed={agentFilter === agentId}
                  onClick={() => setAgentFilter(agentId)}
                >
                  {agents.get(agentId)?.name ?? agentId}
                </button>
              ))}
            </div>
          )}
          <CollapseButton
            collapsed={collapsed}
            controls={ACTIVE_LIST_ID}
            label="les tâches en cours"
            onToggle={toggle}
          />
        </div>
      </div>
      <div id={ACTIVE_LIST_ID} data-collapsed={collapsed ? '' : undefined}>
        {visible.length === 0 && <p className={card.empty}>Aucune tâche en cours.</p>}
        {visible.map(({ job, isChild }) => {
          const agent = agents.get(job.agentId);
          const tool = tools[job.id];
          const approval = pendingByJob.get(job.id);
          return (
            <div key={job.id} className={isChild ? styles.jobChild : styles.job}>
              <div className={styles.jobBody}>
                <div className={styles.jobTitle}>
                  <JobStatusPill status={job.status} />
                  <span>
                    {isChild && '↳ '}
                    {job.title}
                  </span>
                </div>
                <div className={styles.meta}>
                  <span>{isChild ? 'sous-tâche' : (agent?.name ?? job.agentId)}</span>
                  <span className={styles.mono}>{formatDuration(job.startedAt, null, now.getTime())}</span>
                  <span className={styles.mono}>
                    {jobCost(job, agent)} · {formatTokens(job.tokensIn + job.tokensOut)} tokens
                  </span>
                  {job.routingReason && <span>routé : {job.routingReason}</span>}
                </div>
                {approval ? (
                  <div className={styles.tool}>
                    <span>
                      Bloquée sur <span className={styles.mono}>{shortToolName(approval.tool)}</span>
                    </span>
                    <button
                      type="button"
                      className={`${controls.link} ${styles.toolLink}`}
                      onClick={() => onReview(approval.id)}
                    >
                      Examiner
                    </button>
                  </div>
                ) : (
                  tool && (
                    <div className={styles.tool}>
                      <span className={styles.mono}>{shortToolName(tool.tool)}</span>
                      <span className={styles.ellipsis}>{tool.argument}</span>
                      <span className={styles.toolWhen}>{secondsAgo(tool.at, now)}</span>
                    </div>
                  )
                )}
              </div>
              <div className={styles.jobActions}>
                <Link to={jobPath(job.id)} className={controls.secondarySm}>
                  Ouvrir
                </Link>
                {!isChild && (
                  <button type="button" className={controls.dangerSm} onClick={() => setCancelling(job)}>
                    Annuler la tâche
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {cancelling && (
        <ConfirmDialog
          title="Annuler la tâche ?"
          confirmLabel="Annuler la tâche"
          onConfirm={() => onCancel(cancelling)}
          onClose={() => setCancelling(null)}
        >
          « {cancelling.title} » sera interrompue, ainsi que ses sous-tâches en cours.
        </ConfirmDialog>
      )}
    </section>
  );
}

interface AgentsCardProps {
  agents: Agent[];
  jobs: Job[];
  detect: DetectResult | null;
  now: Date;
  timezone: string;
}

export function AgentsCard({ agents, jobs, detect, now, timezone }: AgentsCardProps) {
  return (
    <section aria-label="État des agents" className={card.card}>
      <div className={card.head}>
        <h2 className={card.title}>Agents</h2>
        <div className={card.right}>
          <Link to={ROUTES.agentSettings} className={controls.link}>
            Configurer →
          </Link>
        </div>
      </div>
      {agents.length === 0 && <p className={card.empty}>Aucun agent configuré.</p>}
      {agents.map((agent) => {
        const activity = agentActivity(agent.id, jobs, now, timezone);
        const state = agentState(agent, activity);
        const ratio = budgetRatio(agent, activity);
        return (
          <div key={agent.id} className={agent.enabled ? styles.agent : styles.agentDisabled}>
            <div className={styles.agentTop}>
              <span className={styles.strong}>{agent.name}</span>
              <StatusPill tone={state.tone} dot={state.tone !== 'muted'} pulse={state.pulse}>
                {capitalize(state.text)}
              </StatusPill>
            </div>
            <span className={styles.agentRuntime}>{runtimeSummary(agent, detect)}</span>
            {agent.enabled && ratio !== null && agent.budgetDailyUsd !== null && (
              <>
                <div className={styles.bar} aria-hidden="true">
                  <div
                    className={ratio >= BUDGET_WARN_RATIO ? styles.barFillWarn : styles.barFill}
                    style={{ width: `${String(Math.min(100, Math.round(ratio * 100)))}%` }}
                  />
                </div>
                <div className={styles.agentRow}>
                  <span className={styles.mono}>
                    {budgetLine(activity.costTodayUsd, agent.budgetDailyUsd)}
                  </span>
                  <span className={ratio >= BUDGET_WARN_RATIO ? styles.warnText : undefined}>
                    {Math.round(ratio * 100)} % du budget
                  </span>
                </div>
              </>
            )}
            {agent.enabled && ratio === null && (
              <div className={styles.agentRow}>
                <span>
                  {activity.jobsToday} tâche{activity.jobsToday > 1 ? 's' : ''} aujourd’hui
                  {!agent.isLocalOnly &&
                    activity.costTodayUsd > 0 &&
                    ` · ${formatUsd(activity.costTodayUsd)}`}
                </span>
                <span>
                  {activity.lastEndedAt
                    ? `dernière à ${formatClock(activity.lastEndedAt, timezone)}`
                    : agent.runtime === 'claude-cli'
                      ? 'quota abonnement'
                      : ''}
                </span>
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}

const WATCH_PILLS: Record<WatchItem['kind'], { label: string; tone: 'danger' | 'warn' | 'muted' }> = {
  failed: { label: 'Échec', tone: 'danger' },
  budget: { label: 'Budget', tone: 'warn' },
  missing: { label: 'Outil', tone: 'muted' },
};

export function WatchCard({ items }: { items: WatchItem[] }) {
  if (items.length === 0) {
    return null;
  }
  return (
    <section aria-label="À surveiller" className={styles.watch}>
      <h2 className={card.title}>À surveiller</h2>
      {items.map((item) => (
        <div key={`${item.kind}-${item.jobId ?? item.label}`} className={styles.watchItem}>
          <StatusPill tone={WATCH_PILLS[item.kind].tone}>{WATCH_PILLS[item.kind].label}</StatusPill>
          {item.jobId ? (
            <Link to={jobPath(item.jobId)} className={controls.link}>
              {item.label}
            </Link>
          ) : (
            <span>{item.label}</span>
          )}
        </div>
      ))}
    </section>
  );
}

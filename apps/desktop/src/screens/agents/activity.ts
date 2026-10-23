import type { Agent, Approval, Job, JobEvent } from '@regis/shared';
import { formatUsd } from '../../lib/format';
import { isActive } from '../job/job-view';
import { runtimeLabel } from '../agent-settings/agent-labels';

export const BUDGET_WARN_RATIO = 0.8;
const MAX_ARG_LENGTH = 80;
const TOOL_ARG_KEYS = ['file_path', 'path', 'command', 'pattern', 'query', 'url', 'subject'] as const;

export interface DetectResult {
  /** `simulated` : mode démo, la CLI est le faux binaire des fixtures. */
  claude?: { path: string; version: string; simulated?: boolean };
  ollama?: unknown;
}

export function dayKey(iso: string | Date, timezone: string): string {
  const date = typeof iso === 'string' ? new Date(iso) : iso;
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(date);
}

function isToday(iso: string | null, today: string, timezone: string): boolean {
  return iso !== null && dayKey(iso, timezone) === today;
}

export function finishedToday(jobs: Job[], now: Date, timezone: string): Job[] {
  const today = dayKey(now, timezone);
  return jobs
    .filter((job) => !isActive(job.status) && isToday(job.endedAt ?? job.createdAt, today, timezone))
    .sort((left, right) => (right.endedAt ?? right.createdAt).localeCompare(left.endedAt ?? left.createdAt));
}

function spentToday(job: Job, today: string, timezone: string): boolean {
  return isActive(job.status) || isToday(job.createdAt, today, timezone);
}

export interface ActivityKpis {
  active: number;
  subAgents: number;
  costTodayUsd: number;
  tokensToday: number;
  doneToday: number;
  failedToday: number;
  cancelledToday: number;
}

export function activityKpis(jobs: Job[], now: Date, timezone: string): ActivityKpis {
  const today = dayKey(now, timezone);
  const active = jobs.filter((job) => isActive(job.status));
  const finished = finishedToday(jobs, now, timezone);
  const spending = jobs.filter((job) => spentToday(job, today, timezone));
  return {
    active: active.length,
    subAgents: active.filter((job) => job.parentId !== null).length,
    costTodayUsd: spending.reduce((sum, job) => sum + job.costUsd, 0),
    tokensToday: spending.reduce((sum, job) => sum + job.tokensIn + job.tokensOut, 0),
    doneToday: finished.filter((job) => job.status === 'done').length,
    failedToday: finished.filter((job) => job.status === 'failed').length,
    cancelledToday: finished.filter((job) => job.status === 'cancelled').length,
  };
}

export interface ActiveJobRow {
  job: Job;
  isChild: boolean;
}

export function activeJobRows(jobs: Job[]): ActiveJobRow[] {
  const active = jobs.filter((job) => isActive(job.status));
  const activeIds = new Set(active.map((job) => job.id));
  const byCreated = (left: Job, right: Job) => left.createdAt.localeCompare(right.createdAt);
  const rows: ActiveJobRow[] = [];
  const roots = active
    .filter((job) => job.parentId === null || !activeIds.has(job.parentId))
    .sort((left, right) => byCreated(right, left));
  const walk = (job: Job, isChild: boolean): void => {
    rows.push({ job, isChild });
    for (const child of active.filter((entry) => entry.parentId === job.id).sort(byCreated)) {
      walk(child, true);
    }
  };
  for (const root of roots) {
    walk(root, false);
  }
  return rows;
}

export interface AgentActivity {
  activeCount: number;
  waitingCount: number;
  jobsToday: number;
  costTodayUsd: number;
  lastEndedAt: string | null;
}

export function agentActivity(agentId: string, jobs: Job[], now: Date, timezone: string): AgentActivity {
  const today = dayKey(now, timezone);
  const own = jobs.filter((job) => job.agentId === agentId);
  const spending = own.filter((job) => spentToday(job, today, timezone));
  const ended = own
    .map((job) => job.endedAt)
    .filter((endedAt): endedAt is string => endedAt !== null && isToday(endedAt, today, timezone))
    .sort();
  return {
    activeCount: own.filter((job) => job.status === 'running' || job.status === 'queued').length,
    waitingCount: own.filter((job) => job.status === 'waiting_approval').length,
    jobsToday: spending.length,
    costTodayUsd: spending.reduce((sum, job) => sum + job.costUsd, 0),
    lastEndedAt: ended.at(-1) ?? null,
  };
}

export function budgetRatio(agent: Agent, activity: AgentActivity): number | null {
  if (agent.budgetDailyUsd === null || agent.budgetDailyUsd <= 0) {
    return null;
  }
  return activity.costTodayUsd / agent.budgetDailyUsd;
}

const PLANNED_RUNTIMES = new Set<Agent['runtime']>(['codex-cli', 'gemini-cli']);

export function isAgentAvailable(agent: Agent, detect: DetectResult | null): boolean | null {
  if (detect === null) {
    return null;
  }
  switch (agent.runtime) {
    case 'claude-cli':
      return detect.claude !== undefined;
    case 'ollama':
      return detect.ollama !== undefined;
    case 'anthropic-api':
      return agent.secretRef !== null;
    default:
      return false;
  }
}

export function isAgentSimulated(agent: Agent, detect: DetectResult | null): boolean {
  return agent.runtime === 'claude-cli' && detect?.claude?.simulated === true;
}

/** Ligne d'identité d'un agent : runtime lisible, version ou « Simulé (démo) », modèle. */
export function runtimeSummary(agent: Agent, detect: DetectResult | null): string {
  const parts: string[] = [runtimeLabel(agent.runtime)];
  if (agent.runtime === 'claude-cli' && detect?.claude) {
    parts.push(detect.claude.simulated === true ? 'Simulé (démo)' : `v${detect.claude.version}`);
  } else if (agent.model) {
    parts.push(agent.model);
  }
  if (agent.isLocalOnly) {
    parts.push('local uniquement');
  }
  if (isAgentAvailable(agent, detect) === false) {
    parts.push('indisponible');
  }
  return parts.join(' · ');
}

/** Ligne de budget : « ≈ 0.12 USD / 5.00 USD ». */
export function budgetLine(spentUsd: number, budgetUsd: number): string {
  return `${formatUsd(spentUsd)} / ${formatUsd(budgetUsd, { estimate: false })}`;
}

export type AgentStateTone = 'accent' | 'warn' | 'muted';

export function agentState(
  agent: Agent,
  activity: AgentActivity,
): { text: string; tone: AgentStateTone; pulse: boolean } {
  if (PLANNED_RUNTIMES.has(agent.runtime)) {
    return { text: 'prévu', tone: 'muted', pulse: false };
  }
  if (!agent.enabled) {
    return { text: 'désactivé', tone: 'muted', pulse: false };
  }
  if (activity.waitingCount > 0 && activity.activeCount === 0) {
    return { text: 'bloqué', tone: 'warn', pulse: false };
  }
  if (activity.activeCount > 0) {
    const plural = activity.activeCount > 1 ? 's' : '';
    return { text: `${String(activity.activeCount)} actif${plural}`, tone: 'accent', pulse: true };
  }
  return { text: 'au repos', tone: 'muted', pulse: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function truncate(text: string): string {
  const line = text.split('\n')[0] ?? '';
  return line.length > MAX_ARG_LENGTH ? `${line.slice(0, MAX_ARG_LENGTH - 1)}…` : line;
}

export interface ToolActivity {
  tool: string;
  argument: string;
  at: string;
}

export function lastToolActivity(events: JobEvent[]): ToolActivity | null {
  const last = events.filter((event) => event.type === 'tool_call').at(-1);
  if (!last || !isRecord(last.payloadJson) || typeof last.payloadJson.tool !== 'string') {
    return null;
  }
  const input = last.payloadJson.input;
  const key = isRecord(input) ? TOOL_ARG_KEYS.find((name) => typeof input[name] === 'string') : undefined;
  const argument = key !== undefined && isRecord(input) ? truncate(String(input[key])) : '';
  return { tool: last.payloadJson.tool, argument, at: last.at };
}

export function secondsAgo(iso: string, now: Date): string {
  const seconds = Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / 1000));
  if (seconds < 60) {
    return `il y a ${String(seconds)} s`;
  }
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `il y a ${String(minutes)} min` : `il y a ${String(Math.floor(minutes / 60))} h`;
}

export function waitingMinutes(pending: Approval[], now: Date): number | null {
  const oldest = pending
    .map((approval) => Date.parse(approval.createdAt))
    .sort((left, right) => left - right)[0];
  return oldest === undefined ? null : Math.max(0, Math.floor((now.getTime() - oldest) / 60_000));
}

export function taskTitle(description: string): string {
  return truncate(description.trim());
}

export type WatchKind = 'failed' | 'budget' | 'missing';

export interface WatchItem {
  kind: WatchKind;
  label: string;
  jobId?: string;
}

export function watchList(
  agents: Agent[],
  jobs: Job[],
  detect: DetectResult | null,
  now: Date,
  timezone: string,
): WatchItem[] {
  const items: WatchItem[] = finishedToday(jobs, now, timezone)
    .filter((job) => job.status === 'failed')
    .map((job) => ({ kind: 'failed', label: job.title, jobId: job.id }));
  for (const agent of agents.filter((entry) => entry.enabled)) {
    const ratio = budgetRatio(agent, agentActivity(agent.id, jobs, now, timezone));
    if (ratio !== null && ratio >= BUDGET_WARN_RATIO) {
      items.push({
        kind: 'budget',
        label: `${agent.name} à ${String(Math.round(ratio * 100))} % du budget du jour`,
      });
    }
    if (!PLANNED_RUNTIMES.has(agent.runtime) && isAgentAvailable(agent, detect) === false) {
      items.push({ kind: 'missing', label: missingLabel(agent) });
    }
  }
  return items;
}

function missingLabel(agent: Agent): string {
  switch (agent.runtime) {
    case 'claude-cli':
      return `${agent.name} : CLI non détectée dans le PATH`;
    case 'ollama':
      return `${agent.name} : Ollama injoignable`;
    case 'anthropic-api':
      return `${agent.name} : clé API manquante`;
    default:
      return `${agent.name} : indisponible`;
  }
}

export const HISTORY_PREVIEW_COUNT = 5;

export function jobCost(job: Job, agent: Agent | undefined): string {
  return agent?.isLocalOnly === true ? 'local' : formatUsd(job.costUsd);
}

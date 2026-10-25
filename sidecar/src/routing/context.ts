import type { Agent, Entity, Job, Link } from '@regis/shared';
import { calendarDay } from '../calendar-day';
import { DEFAULT_TIMEZONE, type RoutingContext, type TaskType } from './engine';

export { calendarDay };

export const TIMEZONE_SETTING = 'app.timezone';

export interface ContextRef {
  type: string;
  id: string;
}

export interface RoutingRequest {
  task: string;
  taskType?: TaskType;
  source?: string;
  clientId?: string;
  projectId?: string;
  contextRefs?: ContextRef[];
}

export interface ContextDeps {
  listEntities: () => Promise<Entity[]>;
  listLinks: () => Promise<Link[]>;
  listJobs: () => Promise<Job[]>;
  listAgents: () => Promise<Agent[]>;
  getSetting: (key: string) => Promise<string | null>;
  now?: () => Date;
}

const ENTITY_REF_TYPES = ['entity', 'client', 'project'];
const PERCENT = 100;

export function linkedEntityIds(refs: ContextRef[], links: Link[]): Set<string> {
  const found = new Set<string>();
  for (const ref of refs) {
    if (ENTITY_REF_TYPES.includes(ref.type)) {
      found.add(ref.id);
    }
    for (const link of links) {
      if (link.fromType === ref.type && link.fromId === ref.id && link.toType === 'entity') {
        found.add(link.toId);
      } else if (link.toType === ref.type && link.toId === ref.id && link.fromType === 'entity') {
        found.add(link.fromId);
      }
    }
  }
  return found;
}

export function budgetRemainingPct(
  agents: Agent[],
  jobs: Job[],
  now: Date,
  timezone: string,
): Record<string, number> {
  const today = calendarDay(now, timezone);
  const remaining: Record<string, number> = {};
  for (const agent of agents) {
    if (agent.budgetDailyUsd === null || agent.budgetDailyUsd <= 0) {
      continue;
    }
    const spent = jobs
      .filter((job) => job.agentId === agent.id && calendarDay(new Date(job.createdAt), timezone) === today)
      .reduce((sum, job) => sum + job.costUsd, 0);
    remaining[agent.id] = Math.max(0, PERCENT - (spent / agent.budgetDailyUsd) * PERCENT);
  }
  return remaining;
}

function tagsOf(entity: Entity): string[] {
  return Array.isArray(entity.tagsJson)
    ? (entity.tagsJson as unknown[]).filter((tag): tag is string => typeof tag === 'string')
    : [];
}

export async function buildRoutingContext(
  deps: ContextDeps,
  request: RoutingRequest,
): Promise<RoutingContext> {
  const now = (deps.now ?? (() => new Date()))();
  const timezone = (await deps.getSetting(TIMEZONE_SETTING)) || DEFAULT_TIMEZONE;
  const refs: ContextRef[] = [
    ...(request.contextRefs ?? []),
    ...(request.clientId ? [{ type: 'entity', id: request.clientId }] : []),
    ...(request.projectId ? [{ type: 'entity', id: request.projectId }] : []),
  ];
  const [entities, links, jobs, agents] = await Promise.all([
    refs.length > 0 ? deps.listEntities() : Promise.resolve([]),
    refs.length > 0 ? deps.listLinks() : Promise.resolve([]),
    deps.listJobs(),
    deps.listAgents(),
  ]);
  const linkedIds = linkedEntityIds(refs, links);
  const linked = entities.filter((entity) => linkedIds.has(entity.id));
  return {
    clientIds: linked.filter((entity) => entity.kind === 'client').map((entity) => entity.id),
    projectIds: linked.filter((entity) => entity.kind === 'project').map((entity) => entity.id),
    entityTags: [...new Set(linked.flatMap(tagsOf))],
    taskType: request.taskType ?? 'other',
    ...(request.source === undefined ? {} : { source: request.source }),
    now,
    timezone,
    budgetRemainingPct: budgetRemainingPct(agents, jobs, now, timezone),
  };
}

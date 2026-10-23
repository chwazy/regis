import type { Agent, RoutingRule } from '@regis/shared';

export const TASK_TYPES = [
  'redaction',
  'code',
  'mail_triage',
  'summary',
  'research',
  'extraction',
  'other',
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export interface RoutingConditions {
  client?: string;
  project?: string;
  entityTag?: string;
  taskType?: TaskType;
  source?: string;
  budgetRemainingPctBelow?: number;
  timeWindow?: { from: string; to: string; days?: number[] };
  requireLocal?: boolean;
}

export interface RoutingContext {
  clientIds: string[];
  projectIds: string[];
  entityTags: string[];
  taskType: TaskType;
  source?: string;
  now: Date;
  timezone?: string;
  budgetRemainingPct: Record<string, number>;
}

export interface RoutingDecision {
  agentId: string;
  ruleId: string | null;
  reason: string;
  viaFallback: boolean;
}

export class NoEligibleAgentError extends Error {}

export const DEFAULT_TIMEZONE = 'Europe/Zurich';

const MINUTES_PER_DAY = 24 * 60;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function parseMinutes(hhmm: string): number | null {
  const found = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!found) {
    return null;
  }
  const minutes = Number(found[1]) * 60 + Number(found[2]);
  return minutes < MINUTES_PER_DAY ? minutes : null;
}

function localClock(now: Date, timezone: string): { minutes: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const read = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  const weekday = WEEKDAYS.indexOf(read('weekday')) + 1;
  return { minutes: Number(read('hour')) * 60 + Number(read('minute')), weekday };
}

function matchTimeWindow(window: NonNullable<RoutingConditions['timeWindow']>, ctx: RoutingContext): boolean {
  const from = parseMinutes(window.from);
  const to = parseMinutes(window.to);
  if (from === null || to === null) {
    return false;
  }
  const { minutes, weekday } = localClock(ctx.now, ctx.timezone ?? DEFAULT_TIMEZONE);
  const crossesMidnight = from > to;
  const inside =
    from === to || (crossesMidnight ? minutes >= from || minutes < to : minutes >= from && minutes < to);
  if (!inside) {
    return false;
  }
  if (!window.days || window.days.length === 0) {
    return true;
  }
  const startsPreviousDay = crossesMidnight && minutes < to;
  const windowDay = startsPreviousDay ? ((weekday + 5) % 7) + 1 : weekday;
  return window.days.includes(windowDay);
}

export function matchRule(c: RoutingConditions, ctx: RoutingContext): boolean {
  if (c.client !== undefined && !ctx.clientIds.includes(c.client)) {
    return false;
  }
  if (c.project !== undefined && !ctx.projectIds.includes(c.project)) {
    return false;
  }
  if (c.entityTag !== undefined) {
    const wanted = c.entityTag.toLowerCase();
    if (!ctx.entityTags.some((tag) => tag.toLowerCase() === wanted)) {
      return false;
    }
  }
  if (c.taskType !== undefined && c.taskType !== ctx.taskType) {
    return false;
  }
  if (c.source !== undefined && c.source !== ctx.source) {
    return false;
  }
  if (c.budgetRemainingPctBelow !== undefined) {
    const threshold = c.budgetRemainingPctBelow;
    if (!Object.values(ctx.budgetRemainingPct).some((pct) => pct < threshold)) {
      return false;
    }
  }
  if (c.timeWindow !== undefined && !matchTimeWindow(c.timeWindow, ctx)) {
    return false;
  }
  return true;
}

export function parseConditions(raw: unknown): RoutingConditions {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as RoutingConditions) : {};
}

export function localEligible(agents: Agent[]): Agent[] {
  return agents.filter((agent) => agent.enabled && agent.isLocalOnly);
}

function orderedEnabled(rules: RoutingRule[]): RoutingRule[] {
  return rules.filter((rule) => rule.enabled).sort((left, right) => left.ord - right.ord);
}

export function requiresLocal(ctx: RoutingContext, rules: RoutingRule[]): boolean {
  return orderedEnabled(rules).some((rule) => {
    const conditions = parseConditions(rule.conditionsJson);
    return conditions.requireLocal === true && matchRule(conditions, ctx);
  });
}

export function route(ctx: RoutingContext, rules: RoutingRule[], agents: Agent[]): RoutingDecision | null {
  for (const rule of orderedEnabled(rules)) {
    const conditions = parseConditions(rule.conditionsJson);
    if (!matchRule(conditions, ctx)) {
      continue;
    }
    const target = agents.find((agent) => agent.id === rule.agentId && agent.enabled);
    const label = `Règle n°${String(rule.ord + 1)}${rule.reason === '' ? '' : ` : ${rule.reason}`}`;
    if (conditions.requireLocal !== true) {
      if (target) {
        return { agentId: target.id, ruleId: rule.id, reason: label, viaFallback: false };
      }
      continue;
    }
    if (target?.isLocalOnly) {
      return {
        agentId: target.id,
        ruleId: rule.id,
        reason: `${label} (local uniquement)`,
        viaFallback: false,
      };
    }
    const substitute = localEligible(agents)[0];
    if (!substitute) {
      throw new NoEligibleAgentError('Aucun agent local actif pour une tâche réservée au local');
    }
    return {
      agentId: substitute.id,
      ruleId: rule.id,
      reason: `${label} (local uniquement, agent local de remplacement)`,
      viaFallback: false,
    };
  }
  return null;
}

import type { Agent, RoutingRule } from '@regis/shared';

export type TaskType = 'redaction' | 'code' | 'mail_triage' | 'summary' | 'research' | 'extraction' | 'other';

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

export const TASK_TYPE_OPTIONS: { value: TaskType; label: string }[] = [
  { value: 'redaction', label: 'Rédaction' },
  { value: 'code', label: 'Code' },
  { value: 'mail_triage', label: 'Tri de mails' },
  { value: 'summary', label: 'Synthèse' },
  { value: 'research', label: 'Recherche' },
  { value: 'extraction', label: 'Extraction' },
  { value: 'other', label: 'Autre' },
];

export const WEEKDAY_OPTIONS: { value: number; label: string }[] = [
  { value: 1, label: 'Lun' },
  { value: 2, label: 'Mar' },
  { value: 3, label: 'Mer' },
  { value: 4, label: 'Jeu' },
  { value: 5, label: 'Ven' },
  { value: 6, label: 'Sam' },
  { value: 7, label: 'Dim' },
];

export interface EntityNames {
  [entityId: string]: string;
}

export function conditionsOf(rule: RoutingRule): RoutingConditions {
  const raw = rule.conditionsJson;
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as RoutingConditions) : {};
}

export function cleanConditions(conditions: RoutingConditions): RoutingConditions {
  const cleaned: RoutingConditions = {};
  const text = (value: string | undefined): string | undefined =>
    value !== undefined && value.trim() !== '' ? value.trim() : undefined;
  const client = text(conditions.client);
  const project = text(conditions.project);
  const entityTag = text(conditions.entityTag);
  const source = text(conditions.source);
  if (client) {
    cleaned.client = client;
  }
  if (project) {
    cleaned.project = project;
  }
  if (entityTag) {
    cleaned.entityTag = entityTag;
  }
  if (conditions.taskType) {
    cleaned.taskType = conditions.taskType;
  }
  if (source) {
    cleaned.source = source;
  }
  if (
    conditions.budgetRemainingPctBelow !== undefined &&
    Number.isFinite(conditions.budgetRemainingPctBelow)
  ) {
    cleaned.budgetRemainingPctBelow = conditions.budgetRemainingPctBelow;
  }
  if (conditions.timeWindow && conditions.timeWindow.from !== '' && conditions.timeWindow.to !== '') {
    cleaned.timeWindow = {
      from: conditions.timeWindow.from,
      to: conditions.timeWindow.to,
      ...(conditions.timeWindow.days && conditions.timeWindow.days.length > 0
        ? { days: [...conditions.timeWindow.days].sort((left, right) => left - right) }
        : {}),
    };
  }
  if (conditions.requireLocal === true) {
    cleaned.requireLocal = true;
  }
  return cleaned;
}

export function omitCondition(
  conditions: RoutingConditions,
  key: keyof RoutingConditions,
): RoutingConditions {
  return Object.fromEntries(Object.entries(conditions).filter(([name]) => name !== key));
}

export function describeConditions(conditions: RoutingConditions, names: EntityNames): string {
  const parts: string[] = [];
  const nameOf = (id: string): string => names[id] ?? id;
  if (conditions.client) {
    parts.push(`client = ${nameOf(conditions.client)}`);
  }
  if (conditions.project) {
    parts.push(`projet = ${nameOf(conditions.project)}`);
  }
  if (conditions.entityTag) {
    parts.push(`tag = ${conditions.entityTag}`);
  }
  if (conditions.taskType) {
    const label = TASK_TYPE_OPTIONS.find((option) => option.value === conditions.taskType)?.label;
    parts.push(`tâche = ${label ?? conditions.taskType}`);
  }
  if (conditions.source) {
    parts.push(`source = ${conditions.source}`);
  }
  if (conditions.budgetRemainingPctBelow !== undefined) {
    parts.push(`budget restant < ${String(conditions.budgetRemainingPctBelow)} %`);
  }
  if (conditions.timeWindow) {
    const days = conditions.timeWindow.days
      ?.map((day) => WEEKDAY_OPTIONS.find((option) => option.value === day)?.label ?? String(day))
      .join(', ');
    parts.push(
      `horaire ${conditions.timeWindow.from}–${conditions.timeWindow.to}${days ? ` (${days})` : ''}`,
    );
  }
  return parts.length === 0 ? 'toute tâche' : parts.join(' ET ');
}

export function moveRule<T>(items: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) {
    return items;
  }
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved as T);
  return next;
}

export function withContiguousOrder(rules: RoutingRule[]): RoutingRule[] {
  return rules.map((rule, position) => ({ ...rule, ord: position }));
}

export function newRule(agents: Agent[]): RoutingRule {
  return {
    id: '',
    ord: 0,
    conditionsJson: {},
    agentId: agents.find((agent) => agent.enabled)?.id ?? agents[0]?.id ?? '',
    reason: '',
    enabled: true,
  };
}

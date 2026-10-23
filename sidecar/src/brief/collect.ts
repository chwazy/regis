import type {
  Approval,
  BriefData,
  HourSuggestion,
  Item,
  ItemKind,
  Job,
  JobStatus,
  Link,
} from '@regis/shared';
import { calendarDay, TIMEZONE_SETTING } from '../routing/context';
import { DEFAULT_TIMEZONE } from '../routing/engine';
import { EventData, MessageData } from '../sync/item-schema';
import { suggestHours } from './suggest-hours';

export type { BriefData, HourSuggestion };

export const WEEKLY_TARGET_SETTING = 'brief.weeklyHoursTarget';
export const DEFAULT_WEEKLY_TARGET = 40;
export const UNREAD_WINDOW_HOURS = 48;

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;
const DAYS_PER_WEEK = 7;
const UNKNOWN_PROJECT = 'Sans projet';
const ACTIVE_STATUSES: JobStatus[] = ['queued', 'running', 'waiting_approval'];

export interface BriefCollectDeps {
  listItems: (filter: { kind: ItemKind; since?: string }) => Promise<Item[]>;
  listLinks: () => Promise<Link[]>;
  listPendingApprovals: () => Promise<Approval[]>;
  listJobs: (status: JobStatus) => Promise<Job[]>;
  getSetting: (key: string) => Promise<string | null>;
}

export function weekStartOf(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  const sinceMonday = (date.getUTCDay() + DAYS_PER_WEEK - 1) % DAYS_PER_WEEK;
  return new Date(date.getTime() - sinceMonday * MS_PER_DAY).toISOString().slice(0, 10);
}

export function weekEndOf(day: string): string {
  return new Date(new Date(`${weekStartOf(day)}T00:00:00Z`).getTime() + (DAYS_PER_WEEK - 1) * MS_PER_DAY)
    .toISOString()
    .slice(0, 10);
}

function projectNameOf(entry: Item): string {
  const project = (entry.dataJson as { project?: { name?: unknown } | null } | null)?.project;
  return typeof project?.name === 'string' && project.name !== '' ? project.name : UNKNOWN_PROJECT;
}

function hoursOf(entry: Item): number {
  const hours = (entry.dataJson as { hours?: unknown } | null)?.hours;
  return typeof hours === 'number' && Number.isFinite(hours) ? hours : 0;
}

export function sumWeekHours(
  timeEntries: Item[],
  today: string,
): { weekHours: BriefData['weekHours']; weekTotal: number } {
  const start = weekStartOf(today);
  const end = weekEndOf(today);
  const perProject = new Map<string, number>();
  for (const entry of timeEntries) {
    const day = entry.occurredAt?.slice(0, 10);
    if (day === undefined || day < start || day > end) {
      continue;
    }
    const name = projectNameOf(entry);
    perProject.set(name, (perProject.get(name) ?? 0) + hoursOf(entry));
  }
  const weekHours = [...perProject].map(([projectName, hours]) => ({ projectName, hours }));
  weekHours.sort(
    (left, right) => right.hours - left.hours || left.projectName.localeCompare(right.projectName),
  );
  return { weekHours, weekTotal: weekHours.reduce((sum, row) => sum + row.hours, 0) };
}

export function pickUnreadMails(messages: Item[], now: Date): Item[] {
  const since = now.getTime() - UNREAD_WINDOW_HOURS * MS_PER_HOUR;
  return messages
    .filter((message) => {
      const data = MessageData.safeParse(message.dataJson);
      const receivedAt = message.occurredAt === null ? Number.NaN : Date.parse(message.occurredAt);
      return data.success && !data.data.isRead && receivedAt >= since && receivedAt <= now.getTime();
    })
    .sort((left, right) => Date.parse(right.occurredAt ?? '') - Date.parse(left.occurredAt ?? ''));
}

export function pickTodayEvents(events: Item[], today: string, timezone: string): Item[] {
  return events
    .filter(
      (event) =>
        event.occurredAt !== null &&
        EventData.safeParse(event.dataJson).success &&
        calendarDay(new Date(event.occurredAt), timezone) === today,
    )
    .sort((left, right) => Date.parse(left.occurredAt ?? '') - Date.parse(right.occurredAt ?? ''));
}

function parseTarget(raw: string | null): number {
  const parsed = raw === null ? Number.NaN : Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_WEEKLY_TARGET;
}

export function createBriefCollector(deps: BriefCollectDeps): (now: Date) => Promise<BriefData> {
  return async (now) => {
    const timezone = (await deps.getSetting(TIMEZONE_SETTING)) || DEFAULT_TIMEZONE;
    const today = calendarDay(now, timezone);
    const since = new Date(now.getTime() - UNREAD_WINDOW_HOURS * MS_PER_HOUR).toISOString();
    const [messages, events, timeEntries, projects, invoices, links, pendingApprovals, jobGroups, target] =
      await Promise.all([
        deps.listItems({ kind: 'message', since }),
        deps.listItems({ kind: 'event' }),
        deps.listItems({ kind: 'time_entry' }),
        deps.listItems({ kind: 'project' }),
        deps.listItems({ kind: 'invoice' }),
        deps.listLinks(),
        deps.listPendingApprovals(),
        Promise.all(ACTIVE_STATUSES.map((status) => deps.listJobs(status))),
        deps.getSetting(WEEKLY_TARGET_SETTING),
      ]);
    const todayEvents = pickTodayEvents(events, today, timezone);
    return {
      date: today,
      unreadMails: pickUnreadMails(messages, now),
      todayEvents,
      ...sumWeekHours(timeEntries, today),
      weekTarget: parseTarget(target),
      overdueInvoices: invoices.filter(
        (invoice) => (invoice.dataJson as { overdue?: unknown } | null)?.overdue === true,
      ),
      pendingApprovals,
      activeJobs: jobGroups.flat(),
      hourSuggestions: suggestHours(todayEvents, timeEntries, projects, links, now, timezone),
    };
  };
}

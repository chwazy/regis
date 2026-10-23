import type { HourSuggestion, Item, Link } from '@regis/shared';
import { DEFAULT_TIMEZONE } from '../routing/engine';
import { calendarDay } from '../routing/context';
import { EventData } from '../sync/item-schema';

const MS_PER_HOUR = 3_600_000;
const HOURS_PRECISION = 100;
const MAX_EVENT_HOURS = 12;

interface TimeEntryData {
  project?: { id?: unknown } | null;
}

function projectIdOfEntry(entry: Item): number | null {
  const project = (entry.dataJson as TimeEntryData | null)?.project;
  return typeof project?.id === 'number' ? project.id : null;
}

function hasEntryOnDay(timeEntries: Item[], projectExternalId: number, day: string): boolean {
  return timeEntries.some(
    (entry) => entry.occurredAt?.slice(0, 10) === day && projectIdOfEntry(entry) === projectExternalId,
  );
}

function linkedProject(event: Item, projects: Item[], links: Link[]): Item | undefined {
  const byId = new Map(projects.map((project) => [project.id, project]));
  for (const link of links) {
    if (link.fromType === 'item' && link.fromId === event.id && link.toType === 'item') {
      const project = byId.get(link.toId);
      if (project) {
        return project;
      }
    }
    if (link.toType === 'item' && link.toId === event.id && link.fromType === 'item') {
      const project = byId.get(link.fromId);
      if (project) {
        return project;
      }
    }
  }
  const title = event.title.toLowerCase();
  return projects
    .filter((project) => project.title.trim() !== '' && title.includes(project.title.trim().toLowerCase()))
    .sort((left, right) => right.title.length - left.title.length)[0];
}

export function suggestHours(
  events: Item[],
  timeEntries: Item[],
  projects: Item[],
  links: Link[],
  now: Date,
  timezone: string = DEFAULT_TIMEZONE,
): HourSuggestion[] {
  const today = calendarDay(now, timezone);
  const suggestions: HourSuggestion[] = [];
  for (const event of events) {
    const data = EventData.safeParse(event.dataJson);
    if (!data.success || event.occurredAt === null) {
      continue;
    }
    const start = new Date(event.occurredAt);
    const end = new Date(data.data.end);
    if (calendarDay(start, timezone) !== today || end.getTime() > now.getTime()) {
      continue;
    }
    const hours =
      Math.round(((end.getTime() - start.getTime()) / MS_PER_HOUR) * HOURS_PRECISION) / HOURS_PRECISION;
    if (hours <= 0 || hours > MAX_EVENT_HOURS) {
      continue;
    }
    const project = linkedProject(event, projects, links);
    const projectExternalId = project ? Number.parseInt(project.externalId, 10) : Number.NaN;
    if (!project || !Number.isInteger(projectExternalId)) {
      continue;
    }
    if (hasEntryOnDay(timeEntries, projectExternalId, today)) {
      continue;
    }
    suggestions.push({
      eventItemId: event.id,
      projectExternalId,
      projectName: project.title,
      date: today,
      hours,
      description: event.title,
    });
  }
  return suggestions;
}

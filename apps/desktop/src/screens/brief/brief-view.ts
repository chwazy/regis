import type { BriefData, HourSuggestion, Item } from '@regis/shared';
import { DEFAULT_TIMEZONE, formatClock, formatHours } from '../../lib/format';

export { DEFAULT_TIMEZONE, formatHours };
export const MAX_MAILS_SHOWN = 6;

const MINUTES_PER_HOUR = 60;
const PERCENT = 100;
const MAX_INITIALS = 2;
const ODOO_TIMESHEET_TOOL = 'mcp__odoo__timesheet_create';

export function progressPercent(total: number, target: number): number {
  if (target <= 0) {
    return 0;
  }
  return Math.min(PERCENT, Math.round((total / target) * PERCENT));
}

export function formatBriefDate(date: string): string {
  const label = new Intl.DateTimeFormat('fr-CH', {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date(`${date}T12:00:00Z`));
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function formatTime(iso: string | null, timezone: string): string {
  if (iso === null) {
    return '';
  }
  return formatClock(iso, timezone);
}

export function formatMailTime(iso: string | null, now: Date, timezone: string): string {
  if (iso === null) {
    return '';
  }
  const dayOf = (date: Date): string => new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(date);
  const received = new Date(iso);
  return dayOf(received) === dayOf(now) ? formatTime(iso, timezone) : 'hier';
}

export function deterministicHeadline(data: BriefData): string {
  return `${String(data.unreadMails.length)} mails importants, ${String(data.todayEvents.length)} événements, ${String(data.pendingApprovals.length)} validations en attente`;
}

export function senderOf(mail: Item): string {
  const from = (mail.dataJson as { from?: { name?: string | null; address?: string } | null } | null)?.from;
  return from?.name || from?.address || 'Expéditeur inconnu';
}

export function initialsOf(name: string): string {
  const letters = name
    .split(/[\s@.]+/)
    .filter((part) => part !== '')
    .map((part) => part.charAt(0).toUpperCase());
  return letters.slice(0, MAX_INITIALS).join('') || '?';
}

export function eventMeta(event: Item): string {
  const data = event.dataJson as { end?: string; location?: string | null } | null;
  const parts: string[] = [];
  if (data?.location) {
    parts.push(data.location);
  }
  if (event.occurredAt !== null && data?.end) {
    const minutes = Math.round((Date.parse(data.end) - Date.parse(event.occurredAt)) / 60_000);
    if (minutes > 0) {
      parts.push(
        minutes >= MINUTES_PER_HOUR ? formatHours(minutes / MINUTES_PER_HOUR) : `${String(minutes)} min`,
      );
    }
  }
  return parts.join(' · ');
}

export interface TimesheetCall {
  projectId: number;
  date: string;
  hours: number;
  description: string;
}

export function timesheetCall(suggestion: HourSuggestion): TimesheetCall {
  return {
    projectId: suggestion.projectExternalId,
    date: suggestion.date,
    hours: suggestion.hours,
    description: suggestion.description,
  };
}

export function timesheetJobTitle(suggestion: HourSuggestion): string {
  return `Saisir ${formatHours(suggestion.hours)} sur ${suggestion.projectName}`;
}

export function timesheetJobPrompt(suggestion: HourSuggestion): string {
  return [
    `Call the tool ${ODOO_TIMESHEET_TOOL} exactly once with these arguments, unchanged:`,
    JSON.stringify(timesheetCall(suggestion)),
    'Do nothing else. If the call is refused or put on hold for human validation, stop and report that status.',
  ].join('\n');
}

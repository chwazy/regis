import type { MinutesDraft } from './schema';
import type { MinutesContext } from './prompt';

export interface MinutesMeta {
  title: string;
  startedAt: string;
  durationMs: number | null;
  attendees: MinutesContext['attendees'];
  agentName: string;
  timezone: string;
}

const NONE = 'Aucun(e)';
const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;

function zonedParts(startedAt: string, timezone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('fr-CH', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(startedAt));
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  return {
    date: `${get('day')}.${get('month')}.${get('year')}`,
    time: `${get('hour')}:${get('minute')}`,
  };
}

export function formatDuration(durationMs: number | null): string {
  if (durationMs === null) {
    return '';
  }
  const total = Math.max(0, Math.round(durationMs / MS_PER_MINUTE));
  const hours = Math.floor(total / MINUTES_PER_HOUR);
  const minutes = total % MINUTES_PER_HOUR;
  if (hours === 0) {
    return `${String(minutes)} min`;
  }
  return `${String(hours)} h ${String(minutes).padStart(2, '0')}`;
}

function attendeeLabel(attendee: MinutesContext['attendees'][number]): string {
  return attendee.name !== null && attendee.name.trim() !== '' ? attendee.name : attendee.address;
}

function bullets(items: string[]): string[] {
  return items.length === 0 ? [NONE] : items.map((item) => `- ${item}`);
}

export function renderMinutes(draft: MinutesDraft, meta: MinutesMeta): string {
  const { date, time } = zonedParts(meta.startedAt, meta.timezone);
  const duration = formatDuration(meta.durationMs);
  const header = [
    `# PV — ${meta.title}`,
    '',
    `- **Date** : ${date}`,
    `- **Heure** : ${time}`,
    ...(duration === '' ? [] : [`- **Durée** : ${duration}`]),
    ...(meta.attendees.length === 0
      ? []
      : [`- **Participants** : ${meta.attendees.map(attendeeLabel).join(', ')}`]),
  ];
  const actions = draft.actions.map((action) =>
    action.owner === null ? action.task : `${action.task} (${action.owner})`,
  );
  return [
    ...header,
    '',
    '## Résumé',
    '',
    draft.summary,
    '',
    '## Décisions',
    '',
    ...bullets(draft.decisions),
    '',
    '## Actions',
    '',
    ...bullets(actions),
    '',
    '## Points ouverts',
    '',
    ...bullets(draft.openPoints),
    '',
  ].join('\n');
}

export function minutesTemplateValues(draft: MinutesDraft, meta: MinutesMeta): Record<string, string> {
  const { date, time } = zonedParts(meta.startedAt, meta.timezone);
  const list = (items: string[]): string => bullets(items).join('\n');
  return {
    'pv.titre': meta.title,
    'pv.date': date,
    'pv.heure': time,
    'pv.duree': formatDuration(meta.durationMs),
    'pv.participants': meta.attendees.map(attendeeLabel).join(', '),
    'pv.resume': draft.summary,
    'pv.decisions': list(draft.decisions),
    'pv.actions': list(
      draft.actions.map((action) =>
        action.owner === null ? action.task : `${action.task} (${action.owner})`,
      ),
    ),
    'pv.points': list(draft.openPoints),
  };
}

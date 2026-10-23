import { formatDay } from '../lib/format';

const MAX_VALUE_LENGTH = 120;
const MAX_ROWS = 20;
const NO_VALUE = '—';
const RESULT_KEY = 'Résultat';

export interface KeyValueRow {
  key: string;
  value: string;
}

export function calendarDayIn(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

const MS_PER_DAY = 86_400_000;
const AGENDA_DAYS = 7;

export interface LocalWindows {
  dayStart: string;
  dayEnd: string;
  agendaEnd: string;
  monthStart: string;
  monthEnd: string;
}

function dayParts(day: string): [number, number, number] {
  const [year, month, date] = day.split('-').map(Number);
  return [year ?? 1970, month ?? 1, date ?? 1];
}

function offsetMs(instant: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(instant));
  const part = (type: string): number => Number(parts.find((entry) => entry.type === type)?.value ?? 0);
  const local = Date.UTC(
    part('year'),
    part('month') - 1,
    part('day'),
    part('hour'),
    part('minute'),
    part('second'),
  );
  return local - Math.floor(instant / 1000) * 1000;
}

export function localMidnightUtc(day: string, timezone: string): string {
  const [year, month, date] = dayParts(day);
  const wallClock = Date.UTC(year, month - 1, date);
  const first = wallClock - offsetMs(wallClock, timezone);
  return new Date(wallClock - offsetMs(first, timezone)).toISOString();
}

export function shiftCalendarDay(day: string, delta: number): string {
  const [year, month, date] = dayParts(day);
  return new Date(Date.UTC(year, month - 1, date) + delta * MS_PER_DAY).toISOString().slice(0, 10);
}

export function localWindows(today: string, timezone: string): LocalWindows {
  const [year, month] = dayParts(today);
  const monthStart = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`;
  const nextMonth = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
  return {
    dayStart: localMidnightUtc(today, timezone),
    dayEnd: localMidnightUtc(shiftCalendarDay(today, 1), timezone),
    agendaEnd: localMidnightUtc(shiftCalendarDay(today, AGENDA_DAYS), timezone),
    monthStart: localMidnightUtc(monthStart, timezone),
    monthEnd: localMidnightUtc(nextMonth, timezone),
  };
}

export function formatAmount(amount: number, currency: string | null): string {
  const rounded = new Intl.NumberFormat('fr-CH', { maximumFractionDigits: 0 }).format(amount);
  return currency === null ? rounded : `${currency} ${rounded}`;
}

/** Dernier contact : « 22 oct. » ou « jamais ». */
export function formatLastContact(iso: string | null, timezone: string): string {
  return iso === null ? 'jamais' : formatDay(iso, timezone);
}

export function fileName(relPath: string): string {
  return relPath.split(/[\\/]/).pop() ?? relPath;
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) {
    return NO_VALUE;
  }
  const text =
    typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return text.length > MAX_VALUE_LENGTH ? `${text.slice(0, MAX_VALUE_LENGTH)}…` : text;
}

function toRows(payload: unknown): KeyValueRow[] {
  if (Array.isArray(payload)) {
    return payload.map((entry, index) => ({ key: String(index + 1), value: stringify(entry) }));
  }
  if (typeof payload === 'object' && payload !== null) {
    return Object.entries(payload).map(([key, value]) => ({ key, value: stringify(value) }));
  }
  return [{ key: RESULT_KEY, value: stringify(payload) }];
}

export function toKeyValueRows(result: unknown): KeyValueRow[] {
  const record = (typeof result === 'object' && result !== null ? result : {}) as {
    isError?: unknown;
    structuredContent?: unknown;
    content?: unknown;
  };
  const text = (Array.isArray(record.content) ? record.content : [])
    .map((block: unknown) => (block as { text?: unknown } | null)?.text)
    .filter((part): part is string => typeof part === 'string')
    .join('');
  if (record.isError === true) {
    throw new Error(text || 'Outil MCP en erreur');
  }
  if (typeof record.structuredContent === 'object' && record.structuredContent !== null) {
    return toRows(record.structuredContent).slice(0, MAX_ROWS);
  }
  try {
    return toRows(JSON.parse(text)).slice(0, MAX_ROWS);
  } catch {
    return [{ key: RESULT_KEY, value: stringify(text) }];
  }
}

export type ArgsParse = { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

export function parseToolArgs(text: string): ArgsParse {
  if (text.trim() === '') {
    return { ok: true, value: {} };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return { ok: true, value: parsed as Record<string, unknown> };
    }
    return { ok: false, error: 'Les arguments doivent être un objet JSON.' };
  } catch {
    return { ok: false, error: 'JSON invalide.' };
  }
}

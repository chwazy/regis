/**
 * Formats d'affichage partagés. Toute heure ou date affichée passe par ici, avec le
 * fuseau `app.timezone` : jamais le fuseau du système.
 */

export const DEFAULT_TIMEZONE = 'Europe/Zurich';

const LOCALE = 'fr-CH';
const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;
const SMALL_AMOUNT = 0.01;

function toDate(value: string | Date): Date | null {
  const date = typeof value === 'string' ? new Date(value) : value;
  return Number.isNaN(date.getTime()) ? null : date;
}

function format(value: string | Date | null, timezone: string, options: Intl.DateTimeFormatOptions): string {
  if (value === null) {
    return '—';
  }
  const date = toDate(value);
  return date === null
    ? '—'
    : new Intl.DateTimeFormat(LOCALE, { timeZone: timezone, ...options }).format(date);
}

/** « 14:05 » */
export function formatClock(value: string | Date | null, timezone: string): string {
  return format(value, timezone, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

/** « 22 oct. » */
export function formatDay(value: string | Date | null, timezone: string): string {
  return format(value, timezone, { day: 'numeric', month: 'short' });
}

/** « 22 oct. 2026, 14:05 » */
export function formatDateTime(value: string | Date | null, timezone: string): string {
  return format(value, timezone, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
}

/** « jeu. 14:05 » */
export function formatWeekdayClock(value: string | Date | null, timezone: string): string {
  return format(value, timezone, { weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

/** Date calendaire `YYYY-MM-DD` (échéance Odoo…) : « 22 oct. », sans conversion de fuseau. */
export function formatCalendarDay(day: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? formatDay(`${day}T12:00:00Z`, 'UTC') : day;
}

/** Montant estimé en dollars : « ≈ 0.12 USD », « 0 USD ». */
export function formatUsd(amount: number, options: { estimate?: boolean } = {}): string {
  const estimate = options.estimate ?? true;
  if (amount === 0) {
    return '0 USD';
  }
  const digits = amount < SMALL_AMOUNT ? 4 : 2;
  const value = amount.toFixed(digits);
  return estimate ? `≈ ${value} USD` : `${value} USD`;
}

/** Durée d'une tâche : « < 1 min », « 14 min », « 1 h 05 ». */
export function formatElapsed(startedAt: string | null, endedAt: string | null, now: number): string {
  if (startedAt === null) {
    return '—';
  }
  const end = endedAt === null ? now : Date.parse(endedAt);
  const minutes = Math.max(0, Math.floor((end - Date.parse(startedAt)) / MS_PER_MINUTE));
  if (minutes < 1) {
    return '< 1 min';
  }
  if (minutes < MINUTES_PER_HOUR) {
    return `${String(minutes)} min`;
  }
  return `${String(Math.floor(minutes / MINUTES_PER_HOUR))} h ${String(minutes % MINUTES_PER_HOUR).padStart(2, '0')}`;
}

/** Heures travaillées : « 7h », « 7h30 ». */
export function formatHours(hours: number): string {
  const totalMinutes = Math.round(hours * MINUTES_PER_HOUR);
  const wholeHours = Math.floor(totalMinutes / MINUTES_PER_HOUR);
  const minutes = totalMinutes % MINUTES_PER_HOUR;
  return minutes === 0
    ? `${String(wholeHours)}h`
    : `${String(wholeHours)}h${String(minutes).padStart(2, '0')}`;
}

/** Compteur de tokens : « 950 », « 12.3k ». */
export function formatTokens(count: number): string {
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
}

export function errorMessage(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.message;
  }
  if (typeof reason === 'object' && reason !== null && 'message' in reason) {
    const message = (reason as { message: unknown }).message;
    if (typeof message === 'string') {
      return message;
    }
  }
  return String(reason);
}

import { DEFAULT_TIMEZONE } from './format';

export { DEFAULT_TIMEZONE };

export function supportedTimezones(): string[] {
  return typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
}

export function listTimezones(current: string): string[] {
  const supported = supportedTimezones();
  return supported.includes(current) ? supported : [current, ...supported];
}

/** Fuseau du système si la liste le connaît, sinon `Europe/Zurich`. */
export function systemTimezone(): string {
  const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return supportedTimezones().includes(detected) ? detected : DEFAULT_TIMEZONE;
}

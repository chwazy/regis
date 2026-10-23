import { useEffect, useState } from 'react';
import { DEFAULT_TIMEZONE } from './format';
import { invokeCmd } from './ipc';

const TIMEZONE_KEY = 'app.timezone';

let cached: Promise<string> | null = null;
const listeners = new Set<(timezone: string) => void>();

function loadTimezone(): Promise<string> {
  cached ??= invokeCmd<string | null>('get_setting', { key: TIMEZONE_KEY })
    .then((value) => value || DEFAULT_TIMEZONE)
    .catch(() => {
      cached = null;
      return DEFAULT_TIMEZONE;
    });
  return cached;
}

/** Relit le fuseau (après un changement dans Réglages > Général) et met à jour les écrans montés. */
export function invalidateTimezone(): void {
  cached = null;
  void loadTimezone().then((value) => {
    for (const listener of listeners) {
      listener(value);
    }
  });
}

/** Fuseau `app.timezone`, lu une fois puis partagé par tous les écrans. */
export function useTimezone(): string {
  const [timezone, setTimezone] = useState(DEFAULT_TIMEZONE);
  useEffect(() => {
    let active = true;
    void loadTimezone().then((value) => active && setTimezone(value));
    listeners.add(setTimezone);
    return () => {
      active = false;
      listeners.delete(setTimezone);
    };
  }, []);
  return timezone;
}

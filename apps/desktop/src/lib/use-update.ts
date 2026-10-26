import { useSyncExternalStore } from 'react';
import type { UpdateInfo, UpdateProgress } from '@regis/shared';
import { errorMessage } from './format';
import { invokeCmd, onRegisEvent } from './ipc';
import { DISMISSED_UPDATE_KEY, UPDATE_CHECK_INTERVAL_MS } from './update';

export interface UpdateSnapshot {
  update: UpdateInfo | null;
  checking: boolean;
  checkedAt: number | null;
  installing: boolean;
  progress: UpdateProgress | null;
  error: string | null;
  dismissedVersion: string | null;
}

let snapshot: UpdateSnapshot = {
  update: null,
  checking: false,
  checkedAt: null,
  installing: false,
  progress: null,
  error: null,
  dismissedVersion: null,
};
const listeners = new Set<() => void>();
let stopListening: (() => void) | null = null;

function publish(patch: Partial<UpdateSnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  listeners.forEach((listener) => listener());
}

export async function checkForUpdate(): Promise<void> {
  if (snapshot.checking || snapshot.installing) {
    return;
  }
  publish({ checking: true, error: null });
  try {
    const update = await invokeCmd<UpdateInfo | null>('update_check');
    publish({ update, checking: false, checkedAt: Date.now() });
  } catch (reason) {
    publish({ checking: false, checkedAt: Date.now(), error: errorMessage(reason) });
  }
}

export async function installUpdate(): Promise<void> {
  publish({ installing: true, progress: null, error: null });
  try {
    await invokeCmd<void>('update_install');
  } catch (reason) {
    publish({ installing: false, error: errorMessage(reason) });
  }
}

export async function dismissUpdate(version: string): Promise<void> {
  publish({ dismissedVersion: version });
  await invokeCmd<void>('set_setting', { key: DISMISSED_UPDATE_KEY, value: version }).catch(() => undefined);
}

function startListening(): void {
  const unlisten = onRegisEvent<UpdateProgress>('update.download.progress', (event) => {
    publish({ progress: event.payload });
  });
  const timer = window.setInterval(() => void checkForUpdate(), UPDATE_CHECK_INTERVAL_MS);
  stopListening = () => {
    window.clearInterval(timer);
    void unlisten.then((stop) => stop());
  };
  invokeCmd<string | null>('get_setting', { key: DISMISSED_UPDATE_KEY })
    .then((dismissedVersion) => publish({ dismissedVersion }))
    .catch(() => undefined)
    .finally(() => void checkForUpdate());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    startListening();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stopListening?.();
      stopListening = null;
    }
  };
}

export function useUpdate(): UpdateSnapshot {
  return useSyncExternalStore(subscribe, () => snapshot);
}

import { useCallback, useSyncExternalStore } from 'react';
import type { LocalModuleId, LocalModuleStatus, ModuleDownloadProgress } from '@regis/shared';
import { invokeCmd, onRegisEvent } from './ipc';
import { isModuleOn } from './local-modules';

export interface BackfillProgress {
  done: number;
  total: number;
}

export interface LocalModulesSnapshot {
  modules: readonly LocalModuleStatus[];
  loaded: boolean;
  progress: Partial<Record<LocalModuleId, ModuleDownloadProgress>>;
  backfill: BackfillProgress | null;
}

const MODULE_SETTING_PREFIX = 'modules.';
const MODULE_ORDER: readonly LocalModuleId[] = ['voice', 'embeddings'];

let snapshot: LocalModulesSnapshot = { modules: [], loaded: false, progress: {}, backfill: null };
const listeners = new Set<() => void>();
let stopListening: (() => void) | null = null;

function publish(next: LocalModulesSnapshot): void {
  snapshot = next;
  listeners.forEach((listener) => listener());
}

export async function refreshLocalModules(refresh = false): Promise<readonly LocalModuleStatus[]> {
  try {
    const modules = await invokeCmd<LocalModuleStatus[]>('modules_status', { refresh });
    publish({ ...snapshot, modules, loaded: true });
  } catch {
    publish({ ...snapshot, loaded: true });
  }
  return snapshot.modules;
}

export function applyModuleStatus(status: LocalModuleStatus): void {
  const others = snapshot.modules.filter((module) => module.id !== status.id);
  const modules = [...others, status].sort(
    (left, right) => MODULE_ORDER.indexOf(left.id) - MODULE_ORDER.indexOf(right.id),
  );
  publish({ ...snapshot, modules });
}

function startListening(): void {
  const unlisteners = [
    onRegisEvent<{ key: string }>('settings.changed', (event) => {
      if (event.payload.key.startsWith(MODULE_SETTING_PREFIX)) {
        void refreshLocalModules();
      }
    }),
    onRegisEvent<ModuleDownloadProgress>('module.download.progress', (event) => {
      publish({ ...snapshot, progress: { ...snapshot.progress, [event.payload.id]: event.payload } });
    }),
    onRegisEvent<BackfillProgress>('module.backfill.progress', (event) => {
      const { done, total } = event.payload;
      publish({ ...snapshot, backfill: done >= total ? null : { done, total } });
    }),
  ];
  stopListening = () => unlisteners.forEach((unlisten) => void unlisten.then((stop) => stop()));
  void refreshLocalModules();
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

export function useLocalModules(): LocalModulesSnapshot {
  return useSyncExternalStore(subscribe, () => snapshot);
}

export function useModuleOn(id: LocalModuleId): boolean {
  const { modules } = useLocalModules();
  return isModuleOn(modules, id);
}

export function useModuleActions(): {
  enable: (id: LocalModuleId) => Promise<LocalModuleStatus>;
  disable: (id: LocalModuleId) => Promise<LocalModuleStatus>;
  deleteModel: (id: LocalModuleId) => Promise<LocalModuleStatus>;
  check: (id: LocalModuleId) => Promise<LocalModuleStatus | undefined>;
  recheck: () => Promise<void>;
} {
  const run = useCallback(async (cmd: string, id: LocalModuleId) => {
    const status = await invokeCmd<LocalModuleStatus>(cmd, { id });
    applyModuleStatus(status);
    return status;
  }, []);
  return {
    enable: (id) => run('module_enable', id),
    disable: (id) => run('module_disable', id),
    deleteModel: (id) => run('module_delete_model', id),
    check: async (id) => (await refreshLocalModules(true)).find((module) => module.id === id),
    recheck: async () => {
      await refreshLocalModules(true);
    },
  };
}

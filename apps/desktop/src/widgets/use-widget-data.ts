import { useEffect, useEffectEvent, useState } from 'react';
import type { SyncProgress } from '@regis/shared';
import { debounce } from '../lib/debounce';
import { invokeCmd, onRegisEvent } from '../lib/ipc';
import { errorMessage } from '../lib/format';
import { useTimezone } from '../lib/use-timezone';
import { calendarDayIn, localWindows } from './format';
import { useSourceIssues, type SourceKind } from './source-status';

export const SYNC_REFRESH_DEBOUNCE_MS = 2000;

const MS_PER_MINUTE = 60_000;

export interface WidgetState<T> {
  data: T | null;
  error: string | null;
}

interface RefreshOptions {
  refreshOnSync: boolean;
  refreshMinutes?: number;
}

export function useWidgetData<T>(
  load: () => Promise<T>,
  key: string,
  { refreshOnSync, refreshMinutes }: RefreshOptions,
): WidgetState<T> {
  const [state, setState] = useState<WidgetState<T>>({ data: null, error: null });
  const refresh = useEffectEvent(() => {
    load()
      .then((data) => setState({ data, error: null }))
      .catch((reason: unknown) =>
        setState((current) => ({ data: current.data, error: errorMessage(reason) })),
      );
  });

  useEffect(() => {
    refresh();
    const debouncer = debounce(refresh, SYNC_REFRESH_DEBOUNCE_MS);
    const unlisten = refreshOnSync
      ? onRegisEvent<SyncProgress>('sync.progress', (event) => {
          if (event.payload.phase === 'done') {
            debouncer.trigger();
          }
        })
      : null;
    const interval =
      refreshMinutes !== undefined && refreshMinutes > 0
        ? setInterval(refresh, refreshMinutes * MS_PER_MINUTE)
        : undefined;
    return () => {
      debouncer.cancel();
      if (interval !== undefined) {
        clearInterval(interval);
      }
      void unlisten?.then((stop) => stop());
    };
  }, [key, refreshOnSync, refreshMinutes]);

  return state;
}

export interface LocalDayContext {
  today: string;
  timezone: string;
}

function sourceKinds(source: SourceKind | SourceKind[] | undefined): SourceKind[] {
  if (source === undefined) {
    return [];
  }
  return Array.isArray(source) ? source : [source];
}

export function useCacheWidget<T>(
  kind: string,
  config: object,
  source?: SourceKind | SourceKind[],
  extend?: (context: LocalDayContext) => object,
): WidgetState<T> {
  const timezone = useTimezone();
  const state = useWidgetData<T>(
    async () => {
      const today = calendarDayIn(new Date(), timezone);
      const windows = localWindows(today, timezone);
      return invokeCmd<T>('widget_data', {
        kind,
        config: { ...config, today, windows, ...extend?.({ today, timezone }) },
      });
    },
    `${kind}:${timezone}:${JSON.stringify(config)}`,
    { refreshOnSync: true },
  );
  const issues = useSourceIssues(sourceKinds(source));
  if (issues.errors.length === 0) {
    return state;
  }
  return { data: issues.allFailing ? null : state.data, error: issues.errors.join(' ') };
}

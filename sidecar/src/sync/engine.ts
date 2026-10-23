import { z } from 'zod';
import type { Connector, ConnectorStatus, ItemKind, ItemUpsert, SyncProgress } from '@regis/shared';
import type { McpHost } from '../mcp/host';

export interface SyncResult {
  connectorId: string;
  kind: ItemKind;
  upserted: number;
  durationMs: number;
  error?: string;
}

export interface SyncStore {
  listConnectors: () => Promise<Connector[]>;
  upsertItems: (items: ItemUpsert[]) => Promise<number>;
  recordSync: (connectorId: string, status: 'ok' | 'error', lastSyncAt?: string) => Promise<void>;
}

export interface SyncContext {
  store: SyncStore;
  now: () => Date;
}

export interface Syncer {
  connectorKind: string;
  run(
    connector: Connector,
    host: McpHost,
    since: string | undefined,
    context: SyncContext,
  ): Promise<SyncResult[]>;
}

export interface SyncEngineOptions {
  host: McpHost;
  store: SyncStore;
  onProgress: (progress: SyncProgress) => void;
  onLog: (line: string) => void;
  now?: () => Date;
}

const DEFAULT_INTERVAL_MINUTES = 5;
const MS_PER_MINUTE = 60_000;

const syncSettings = z.object({ intervalMinutes: z.number().positive().optional() });

export function intervalMinutesOf(connector: Connector): number {
  const parsed = syncSettings.safeParse(connector.syncJson);
  return (parsed.success ? parsed.data.intervalMinutes : undefined) ?? DEFAULT_INTERVAL_MINUTES;
}

export class SyncEngine {
  private readonly syncers = new Map<string, Syncer>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly running = new Map<string, Promise<SyncResult[]>>();

  constructor(private readonly options: SyncEngineOptions) {}

  register(syncer: Syncer): void {
    this.syncers.set(syncer.connectorKind, syncer);
  }

  schedule(connector: Connector): void {
    this.unschedule(connector.id);
    if (!connector.enabled || !this.syncers.has(connector.kind)) {
      return;
    }
    const tick = (): void => {
      this.runNow(connector.id).catch((error: unknown) => {
        this.options.onLog(`[sync:${connector.name}] ${errorMessage(error)}`);
      });
    };
    tick();
    this.timers.set(connector.id, setInterval(tick, intervalMinutesOf(connector) * MS_PER_MINUTE));
  }

  unschedule(connectorId: string): void {
    const timer = this.timers.get(connectorId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(connectorId);
    }
  }

  stop(): void {
    for (const connectorId of [...this.timers.keys()]) {
      this.unschedule(connectorId);
    }
  }

  async track(status: ConnectorStatus): Promise<void> {
    if (status.state !== 'connected') {
      this.unschedule(status.connectorId);
      return;
    }
    const connector = (await this.options.store.listConnectors()).find(
      (candidate) => candidate.id === status.connectorId,
    );
    if (connector) {
      this.schedule(connector);
    }
  }

  runNow(connectorId: string): Promise<SyncResult[]> {
    const current = this.running.get(connectorId);
    if (current) {
      return current;
    }
    const started = this.execute(connectorId).finally(() => this.running.delete(connectorId));
    this.running.set(connectorId, started);
    return started;
  }

  private async execute(connectorId: string): Promise<SyncResult[]> {
    const { store, host, onProgress } = this.options;
    const now = this.options.now ?? (() => new Date());
    const connector = (await store.listConnectors()).find((candidate) => candidate.id === connectorId);
    if (!connector) {
      throw new Error(`Unknown connector: ${connectorId}`);
    }
    const syncer = this.syncers.get(connector.kind);
    if (!syncer) {
      throw new Error(`No syncer registered for connector kind: ${connector.kind}`);
    }
    onProgress({ connectorId, phase: 'started' });
    let results: SyncResult[];
    try {
      results = await syncer.run(connector, host, connector.lastSyncAt ?? undefined, { store, now });
    } catch (error) {
      const message = errorMessage(error);
      await store.recordSync(connectorId, 'error');
      onProgress({ connectorId, phase: 'error', error: message });
      throw error;
    }
    for (const result of results) {
      onProgress({
        connectorId,
        kind: result.kind,
        upserted: result.upserted,
        phase: result.error === undefined ? 'done' : 'error',
        ...(result.error === undefined ? {} : { error: result.error }),
      });
    }
    const failed = results.some((result) => result.error !== undefined);
    await store.recordSync(connectorId, failed ? 'error' : 'ok', failed ? undefined : now().toISOString());
    return results;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

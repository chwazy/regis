import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Connector } from '@regis/shared';
import type { McpHost } from '../mcp/host';
import { SyncEngine, intervalMinutesOf, type SyncResult, type SyncStore, type Syncer } from './engine';

function connector(overrides: Partial<Connector> = {}): Connector {
  return {
    id: 'c1',
    kind: 'fake',
    name: 'Fake',
    transport: 'stdio',
    command: 'x',
    argsJson: [],
    url: null,
    envJson: {},
    secretRef: null,
    enabled: true,
    syncJson: { intervalMinutes: 5 },
    status: 'unknown',
    lastSyncAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('SyncEngine scheduling', () => {
  const runs: string[] = [];
  let current: Connector;
  let engine: SyncEngine;

  beforeEach(() => {
    vi.useFakeTimers();
    runs.length = 0;
    current = connector();
    const store: SyncStore = {
      listConnectors: () => Promise.resolve([current]),
      upsertItems: () => Promise.resolve(0),
      recordSync: () => Promise.resolve(),
    };
    const syncer: Syncer = {
      connectorKind: 'fake',
      run: (target) => {
        runs.push(target.id);
        return Promise.resolve<SyncResult[]>([
          { connectorId: target.id, kind: 'message', upserted: 0, durationMs: 0 },
        ]);
      },
    };
    engine = new SyncEngine({
      host: {} as McpHost,
      store,
      onProgress: () => undefined,
      onLog: () => undefined,
    });
    engine.register(syncer);
  });

  afterEach(() => {
    engine.stop();
    vi.useRealTimers();
  });

  it('runs at t=0 then every 5 minutes, and not before', async () => {
    engine.schedule(current);
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
    expect(runs).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(runs).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(runs).toHaveLength(3);
  });

  it('follows a custom interval and replaces the previous schedule', async () => {
    engine.schedule(current);
    await vi.advanceTimersByTimeAsync(0);
    current = connector({ syncJson: { intervalMinutes: 1 } });
    engine.schedule(current);
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(runs).toHaveLength(3);
  });

  it('does not schedule a disabled or unknown-kind connector', async () => {
    engine.schedule(connector({ enabled: false }));
    engine.schedule(connector({ kind: 'other' }));
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(runs).toHaveLength(0);
  });

  it('stops running once the connector is no longer connected', async () => {
    await engine.track({ connectorId: 'c1', state: 'connected', toolCount: 1, since: '' });
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toHaveLength(1);

    await engine.track({ connectorId: 'c1', state: 'stopped', toolCount: 0, since: '' });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(runs).toHaveLength(1);
  });

  it('shares one in-flight run between concurrent runNow calls', async () => {
    await Promise.all([engine.runNow('c1'), engine.runNow('c1')]);
    expect(runs).toHaveLength(1);
  });

  it('rejects an unknown connector', async () => {
    await expect(engine.runNow('missing')).rejects.toThrow(/Unknown connector/);
  });
});

describe('intervalMinutesOf', () => {
  it('defaults to 5 minutes', () => {
    expect(intervalMinutesOf(connector({ syncJson: {} }))).toBe(5);
    expect(intervalMinutesOf(connector({ syncJson: { intervalMinutes: -3 } }))).toBe(5);
  });
});

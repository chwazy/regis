import { describe, expect, it } from 'vitest';
import type { Connector, ItemUpsert } from '@regis/shared';
import { McpCallError, type McpHost } from '../mcp/host';
import { SyncEngine, type SyncStore } from './engine';
import { readFixture, toolText, type ToolFixture } from './fixtures';
import { m365Syncer, mapEvent, mapMessage, parseToolPage } from './m365';

const messages = readFixture<ToolFixture>('ms365.messages.json');
const events = readFixture<ToolFixture>('ms365.events.json');
const ISO_8601_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function m365Connector(): Connector {
  return {
    id: 'c-m365',
    kind: 'm365',
    name: 'Microsoft 365',
    transport: 'stdio',
    command: 'npx',
    argsJson: [],
    url: null,
    envJson: {},
    secretRef: null,
    enabled: true,
    syncJson: { intervalMinutes: 5 },
    status: 'unknown',
    lastSyncAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

class MemoryStore implements SyncStore {
  readonly items = new Map<string, ItemUpsert>();
  readonly records: { status: string; lastSyncAt?: string }[] = [];

  constructor(private readonly connector: Connector) {}

  listConnectors = () => Promise.resolve([this.connector]);

  upsertItems = (items: ItemUpsert[]) => {
    for (const item of items) {
      this.items.set(`${item.connectorId}|${item.kind}|${item.externalId}`, item);
    }
    return Promise.resolve(items.length);
  };

  recordSync = (_connectorId: string, status: 'ok' | 'error', lastSyncAt?: string) => {
    this.records.push({ status, ...(lastSyncAt === undefined ? {} : { lastSyncAt }) });
    return Promise.resolve();
  };
}

function fixtureHost(failing = false): McpHost {
  return {
    callTool: (connectorId: string, tool: string) => {
      if (failing) {
        return Promise.reject(new McpCallError(connectorId, tool, 'Graph unavailable'));
      }
      return Promise.resolve(toolText(tool === 'get-calendar-view' ? events : messages));
    },
  } as unknown as McpHost;
}

describe('synthetic fixtures', () => {
  it('are marked synthetic', () => {
    expect(messages._meta.synthetic).toBe(true);
    expect(events._meta.synthetic).toBe(true);
  });
});

describe('mapMessage', () => {
  it.each(messages.value.map((raw, index) => [index, raw] as const))(
    'maps fixture message %i',
    (_index, raw) => {
      const item = mapMessage(raw, 'c1');
      const source = raw as { id: string; subject: string; receivedDateTime: string };
      expect(item.kind).toBe('message');
      expect(item.connectorId).toBe('c1');
      expect(item.externalId).toBe(source.id);
      expect(item.externalId.length).toBeGreaterThan(0);
      expect(item.title).toBe(source.subject === '' ? '(sans objet)' : source.subject);
      expect(item.occurredAt).toMatch(ISO_8601_UTC);
      expect(item.occurredAt).toBe(new Date(source.receivedDateTime).toISOString());
    },
  );

  it('keeps sender, recipients and flags in dataJson', () => {
    const item = mapMessage(messages.value[0], 'c1');
    expect(item.bodyText).toContain('planning');
    expect(item.dataJson).toMatchObject({
      from: { name: 'Alice Example', address: 'alice@example.test' },
      to: [{ address: 'regis.user@example.test' }],
      cc: [{ address: 'bob@example.test' }],
      isRead: false,
      importance: 'normal',
      conversationId: 'AAQkSYNTHETICCONV01',
    });
  });

  it('rejects a message without id', () => {
    expect(() => mapMessage({ subject: 'x', receivedDateTime: '2026-01-01T00:00:00Z' }, 'c1')).toThrow();
  });
});

describe('mapEvent', () => {
  it.each(events.value.map((raw, index) => [index, raw] as const))('maps fixture event %i', (_index, raw) => {
    const item = mapEvent(raw, 'c1');
    const source = raw as { id: string; subject: string; start: { dateTime: string } };
    expect(item.kind).toBe('event');
    expect(item.externalId).toBe(source.id);
    expect(item.title).toBe(source.subject);
    expect(item.occurredAt).toBe(new Date(`${source.start.dateTime}Z`).toISOString());
    expect(item.occurredAt).toMatch(ISO_8601_UTC);
    expect((item.dataJson as { end: string }).end).toMatch(ISO_8601_UTC);
  });

  it('keeps location, attendees and meeting url', () => {
    const item = mapEvent(events.value[0], 'c1');
    expect(item.dataJson).toMatchObject({
      location: 'Meeting room 2',
      onlineMeetingUrl: 'https://meet.example.test/join/synthetic-0001',
      attendees: [
        { address: 'regis.user@example.test', response: 'accepted' },
        { address: 'bob@example.test' },
      ],
    });
  });

  it('keeps the Teams join url, isOnlineMeeting and provider', () => {
    const raw = events.value[2] as { onlineMeeting: { joinUrl: string } };
    const item = mapEvent(raw, 'c1');
    expect(item.dataJson).toMatchObject({
      onlineMeetingUrl: raw.onlineMeeting.joinUrl,
      isOnlineMeeting: true,
      onlineMeetingProvider: 'teamsForBusiness',
    });
  });

  it('yields a null onlineMeetingUrl without online meeting', () => {
    const item = mapEvent(events.value[3], 'c1');
    expect(item.dataJson).toMatchObject({ onlineMeetingUrl: null, isOnlineMeeting: false });
  });

  it('flags the cancelled event', () => {
    expect(mapEvent(events.value[4], 'c1').dataJson).toMatchObject({ isCancelled: true });
  });

  it('refuses a local time without UTC time zone', () => {
    const raw = {
      id: 'e',
      start: { dateTime: '2026-10-23T08:00:00', timeZone: 'W. Europe Standard Time' },
      end: { dateTime: '2026-10-23T09:00:00', timeZone: 'W. Europe Standard Time' },
    };
    expect(() => mapEvent(raw, 'c1')).toThrow(/time zone/);
  });
});

describe('parseToolPage', () => {
  it('throws the tool text when the call is an error', () => {
    expect(() => parseToolPage({ isError: true, content: [{ type: 'text', text: 'AADSTS65001' }] })).toThrow(
      'AADSTS65001',
    );
  });

  it('throws on a non-JSON body', () => {
    expect(() => parseToolPage(toolText('hello'))).toThrow(/illisible/);
  });
});

describe('m365Syncer through SyncEngine', () => {
  const now = new Date('2026-10-22T10:00:00.000Z');

  function createEngine(store: MemoryStore, host: McpHost) {
    const progress: unknown[] = [];
    const engine = new SyncEngine({
      host,
      store,
      onProgress: (entry) => progress.push(entry),
      onLog: () => undefined,
      now: () => now,
    });
    engine.register(m365Syncer);
    return { engine, progress };
  }

  it('keeps the same item count after two consecutive runs', async () => {
    const connector = m365Connector();
    const store = new MemoryStore(connector);
    const { engine } = createEngine(store, fixtureHost());

    const first = await engine.runNow(connector.id);
    const countAfterFirst = store.items.size;
    const second = await engine.runNow(connector.id);

    expect(first.map((result) => [result.kind, result.upserted])).toEqual([
      ['message', 3],
      ['event', 5],
    ]);
    expect(second.map((result) => result.upserted)).toEqual([3, 5]);
    expect(countAfterFirst).toBe(8);
    expect(store.items.size).toBe(countAfterFirst);
    expect(store.records.at(-1)).toEqual({ status: 'ok', lastSyncAt: now.toISOString() });
  });

  it('flags the connector in error and keeps existing items when the tool fails', async () => {
    const connector = m365Connector();
    const store = new MemoryStore(connector);
    await createEngine(store, fixtureHost()).engine.runNow(connector.id);
    const existing = store.items.size;

    const { engine, progress } = createEngine(store, fixtureHost(true));
    const results = await engine.runNow(connector.id);

    expect(results.every((result) => result.error === 'Graph unavailable')).toBe(true);
    expect(store.records.at(-1)).toEqual({ status: 'error' });
    expect(progress).toContainEqual(
      expect.objectContaining({ connectorId: connector.id, phase: 'error', error: 'Graph unavailable' }),
    );
    expect(store.items.size).toBe(existing);
  });

  it('requests the inbox over 14 days and the calendar from D-1 to D+14', async () => {
    const connector = m365Connector();
    const calls: { tool: string; args: Record<string, unknown> }[] = [];
    const host = {
      callTool: (_id: string, tool: string, args: Record<string, unknown>) => {
        calls.push({ tool, args });
        return Promise.resolve(toolText({ value: [] }));
      },
    } as unknown as McpHost;

    await createEngine(new MemoryStore(connector), host).engine.runNow(connector.id);

    expect(calls[0]?.tool).toBe('list-mail-folder-messages');
    expect(calls[0]?.args).toMatchObject({
      mailFolderId: 'inbox',
      filter: 'receivedDateTime ge 2026-10-08T10:00:00.000Z',
    });
    expect(calls[1]?.tool).toBe('get-calendar-view');
    expect(calls[1]?.args.select).toEqual(
      expect.arrayContaining(['isOnlineMeeting', 'onlineMeetingProvider', 'onlineMeeting']),
    );
    expect(calls[1]?.args).toMatchObject({
      startDateTime: '2026-10-21T10:00:00.000Z',
      endDateTime: '2026-11-05T10:00:00.000Z',
    });
  });

  it('stops paginating at 500 messages', async () => {
    const connector = m365Connector();
    let mailCalls = 0;
    const host = {
      callTool: (_id: string, tool: string, args: { top?: number }) => {
        if (tool !== 'list-mail-folder-messages') {
          return Promise.resolve(toolText({ value: [] }));
        }
        mailCalls += 1;
        const page = Array.from({ length: args.top ?? 0 }, (_unused, index) => ({
          id: `m-${mailCalls}-${index}`,
          receivedDateTime: '2026-10-20T07:15:30Z',
        }));
        return Promise.resolve(toolText({ value: page }));
      },
    } as unknown as McpHost;
    const store = new MemoryStore(connector);

    await createEngine(store, host).engine.runNow(connector.id);

    expect(mailCalls).toBe(5);
    expect(store.items.size).toBe(500);
  });

  it('paginates the calendar view beyond 100 events', async () => {
    const connector = m365Connector();
    const total = 250;
    const skips: unknown[] = [];
    const host = {
      callTool: (_id: string, tool: string, args: { top?: number; skip?: number }) => {
        if (tool !== 'get-calendar-view') {
          return Promise.resolve(toolText({ value: [] }));
        }
        const skip = args.skip ?? 0;
        skips.push(skip);
        const count = Math.max(0, Math.min(args.top ?? 0, total - skip));
        const page = Array.from({ length: count }, (_unused, index) => ({
          id: `e-${skip + index}`,
          start: { dateTime: '2026-10-25T09:00:00', timeZone: 'UTC' },
          end: { dateTime: '2026-10-25T10:00:00', timeZone: 'UTC' },
        }));
        return Promise.resolve(toolText({ value: page }));
      },
    } as unknown as McpHost;
    const store = new MemoryStore(connector);

    await createEngine(store, host).engine.runNow(connector.id);

    expect(skips).toEqual([0, 100, 200]);
    expect(store.items.size).toBe(total);
  });
});

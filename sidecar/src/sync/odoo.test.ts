import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Connector, ItemUpsert } from '@regis/shared';
import type { McpHost } from '../mcp/host';
import { OdooClient } from '../connectors/odoo-mcp/client';
import { createOdooTools, runOdooTool } from '../connectors/odoo-mcp/tools';
import {
  FAKE_API_KEY,
  FAKE_DB,
  FAKE_LOGIN,
  startFakeOdoo,
  type FakeOdoo,
} from '../../../tests/servers/fake-odoo.mjs';
import { SyncEngine, type SyncStore } from './engine';
import { mapInvoice, odooSyncer } from './odoo';

const NOW = new Date('2026-10-22T10:00:00.000Z');

function odooConnector(): Connector {
  return {
    id: 'c-odoo',
    kind: 'odoo',
    name: 'Odoo',
    transport: 'stdio',
    command: 'node',
    argsJson: [],
    url: null,
    envJson: {},
    secretRef: null,
    enabled: true,
    syncJson: {},
    status: 'unknown',
    lastSyncAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

class MemoryStore implements SyncStore {
  readonly items = new Map<string, ItemUpsert>();

  constructor(private readonly connector: Connector) {}

  listConnectors = () => Promise.resolve([this.connector]);

  upsertItems = (items: ItemUpsert[]) => {
    for (const item of items) {
      this.items.set(`${item.connectorId}|${item.kind}|${item.externalId}`, item);
    }
    return Promise.resolve(items.length);
  };

  recordSync = () => Promise.resolve();
}

let odoo: FakeOdoo;

beforeAll(async () => {
  odoo = await startFakeOdoo();
});

afterAll(async () => {
  await odoo.close();
});

function hostFor(server: FakeOdoo): McpHost {
  const client = new OdooClient({ url: server.url, db: FAKE_DB, login: FAKE_LOGIN, apiKey: FAKE_API_KEY });
  const tools = createOdooTools(client, () => NOW);
  return {
    callTool: (_connectorId: string, name: string, args: Record<string, unknown>) => {
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool) {
        throw new Error(`Unknown tool ${name}`);
      }
      return runOdooTool(tool, args);
    },
  } as unknown as McpHost;
}

function engineFor(host: McpHost, store: MemoryStore): SyncEngine {
  const engine = new SyncEngine({
    host,
    store,
    onProgress: () => undefined,
    onLog: () => undefined,
    now: () => NOW,
  });
  engine.register(odooSyncer);
  return engine;
}

describe('odooSyncer', () => {
  it('creates items of the five kinds and does not duplicate on a second sync', async () => {
    const store = new MemoryStore(odooConnector());
    const engine = engineFor(hostFor(odoo), store);
    const first = await engine.runNow('c-odoo');
    expect(first.every((result) => result.error === undefined)).toBe(true);
    const kinds = new Set([...store.items.values()].map((item) => item.kind));
    expect(kinds).toEqual(new Set(['partner', 'project', 'task', 'time_entry', 'invoice']));
    const count = store.items.size;
    await engine.runNow('c-odoo');
    expect(store.items.size).toBe(count);
  });

  it('skips time entries when the Timesheets module is missing without failing the sync', async () => {
    const withoutTimesheets = await startFakeOdoo({ missingModels: ['account.analytic.line'] });
    try {
      const store = new MemoryStore(odooConnector());
      const results = await engineFor(hostFor(withoutTimesheets), store).runNow('c-odoo');
      expect(results.every((result) => result.error === undefined)).toBe(true);
      expect([...store.items.values()].some((item) => item.kind === 'time_entry')).toBe(false);
      expect([...store.items.values()].some((item) => item.kind === 'invoice')).toBe(true);
    } finally {
      await withoutTimesheets.close();
    }
  });
});

describe('mapInvoice', () => {
  const base = {
    id: 1,
    name: 'INV/1',
    partner_id: [11, 'Acme SA'],
    invoice_date: '2026-08-01',
    amount_total: 10,
    currency_id: [5, 'CHF'],
    state: 'posted',
    write_date: '2026-08-01 09:00:00',
  };

  it.each([
    ['2026-10-01', 'not_paid', true],
    ['2026-10-01', 'partial', true],
    ['2026-10-01', 'paid', false],
    ['2026-10-01', 'in_payment', false],
    ['2026-10-01', 'reversed', false],
    ['2026-10-22', 'not_paid', false],
    ['2026-11-01', 'not_paid', false],
  ])('due %s with payment state %s gives overdue=%s', (due, paymentState, expected) => {
    const item = mapInvoice(
      { ...base, invoice_date_due: due, payment_state: paymentState },
      'c',
      '2026-10-22',
    );
    expect((item.dataJson as { overdue: boolean }).overdue).toBe(expected);
  });

  it('stores Many2one values as { id, name } and the invoice date untouched', () => {
    const item = mapInvoice({ ...base, invoice_date_due: false, payment_state: 'paid' }, 'c', '2026-10-22');
    expect(item.dataJson).toMatchObject({ partner: { id: 11, name: 'Acme SA' }, dueDate: null });
    expect(item.occurredAt).toBe('2026-08-01');
  });
});

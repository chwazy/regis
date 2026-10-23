import { describe, expect, it, vi } from 'vitest';
import type { Agent, Connector, Entity, EntityCard, ItemUpsert, Job, NewJob } from '@regis/shared';
import type { SynthesisSaveInput } from '../brain/synthesis';
import { buildDemoItems } from './dataset';
import { demoAgentEnv, isDemoMode, seedDemo, type DemoSeedDeps } from './seed';

const NOW = new Date('2026-10-22T09:00:00Z');
const SOURCES = { m365: 'c-m365', odoo: 'c-odoo' };

function countBy(items: ItemUpsert[]): Record<string, number> {
  return items.reduce<Record<string, number>>((counts, item) => {
    counts[item.kind] = (counts[item.kind] ?? 0) + 1;
    return counts;
  }, {});
}

describe('buildDemoItems', () => {
  it('maps every kind through the real connector mappers', () => {
    const items = buildDemoItems(NOW, SOURCES, 'Europe/Zurich');
    expect(countBy(items)).toEqual({
      message: 6,
      event: 6,
      partner: 4,
      project: 3,
      task: 5,
      time_entry: 5,
      invoice: 3,
    });
    expect(new Set(items.map((item) => `${item.kind}:${item.externalId}`)).size).toBe(items.length);
  });

  it('places mails, events and hours around the given day', () => {
    const items = buildDemoItems(NOW, SOURCES, 'Europe/Zurich');
    const messages = items.filter((item) => item.kind === 'message');
    expect(
      messages.every((item) => item.connectorId === 'c-m365' && (item.occurredAt ?? '') < NOW.toISOString()),
    ).toBe(true);
    const firstEvent = items.find((item) => item.externalId === 'demo-event-standup');
    expect(firstEvent?.occurredAt).toBe('2026-10-22T06:30:00.000Z');
    const hours = items.filter((item) => item.kind === 'time_entry');
    expect(
      hours.every(
        (item) => (item.occurredAt ?? '') >= '2026-10-19' && (item.occurredAt ?? '') < '2026-10-22',
      ),
    ).toBe(true);
  });

  it('marks only the unpaid invoice past its due date as overdue', () => {
    const invoices = buildDemoItems(NOW, SOURCES, 'Europe/Zurich').filter((item) => item.kind === 'invoice');
    const overdue = invoices.filter((item) => (item.dataJson as { overdue: boolean }).overdue);
    expect(overdue.map((item) => item.title)).toEqual(['FAC/2026/0128']);
  });

  it('only keeps hours logged before today on a Monday', () => {
    const monday = buildDemoItems(new Date('2026-10-19T09:00:00Z'), SOURCES, 'Europe/Zurich');
    expect(monday.filter((item) => item.kind === 'time_entry')).toEqual([]);
  });
});

describe('demo environment', () => {
  it('requires the exact flag', () => {
    expect(isDemoMode({ REGIS_DEMO: '1' })).toBe(true);
    expect(isDemoMode({ REGIS_DEMO: 'true' })).toBe(false);
    expect(isDemoMode({})).toBe(false);
  });

  it('forwards only the fake Claude variables to agents', () => {
    expect(demoAgentEnv({ FAKE_CLAUDE_FIXTURE: 'a.ndjson', REGIS_DEMO: '1', PATH: 'x' })).toEqual({
      FAKE_CLAUDE_FIXTURE: 'a.ndjson',
    });
  });
});

function connector(id: string, kind: string): Connector {
  return {
    id,
    kind,
    name: kind,
    transport: 'stdio',
    command: null,
    argsJson: [],
    url: null,
    envJson: {},
    secretRef: null,
    enabled: false,
    syncJson: {},
    status: 'ok',
    lastSyncAt: null,
    createdAt: NOW.toISOString(),
  };
}

function demoEntity(id: string, name: string): Entity {
  return { id, kind: 'client', name, tagsJson: [], dataJson: {}, createdAt: '', updatedAt: '' };
}

function seedDeps(overrides: Partial<DemoSeedDeps> = {}) {
  const jobs: NewJob[] = [];
  const savedSyntheses: SynthesisSaveInput[] = [];
  const entities = [demoEntity('E1', 'Fromagerie du Jorat'), demoEntity('E2', 'Claire Rochat')];
  const deps: DemoSeedDeps = {
    listConnectors: async () => [connector('c-m365', 'm365'), connector('c-odoo', 'odoo')],
    listAgents: async () => [
      { id: 'a-off', enabled: false } as Agent,
      { id: 'a-claude', enabled: true } as Agent,
    ],
    listJobs: async () => [],
    upsertItems: async (items) => items.length,
    bootstrapBrain: vi.fn(async () => undefined),
    syntheses: {
      listEntities: async () => entities,
      listSyntheses: async () => [],
      entityCard: async (id) =>
        ({
          entity: entities.find((entity) => entity.id === id),
          facts: [],
          timeline: [{ id: 'I1', kind: 'message', at: null, text: 'Alarme' }],
          notes: [],
          projects: [],
        }) as unknown as EntityCard,
      saveSynthesis: async (input) => {
        savedSyntheses.push(input);
        return { ...input, generatedAt: NOW.toISOString() };
      },
    },
    createJob: async (job) => {
      jobs.push(job);
      return { ...job, id: `job-${String(jobs.length)}` } as unknown as Job;
    },
    appendEvent: vi.fn(async (event) => ({ ...event, id: 1 }) as never),
    updateJob: vi.fn(async (id) => ({ id }) as Job),
    requestApproval: vi.fn(async () => ({ status: 'approved' })),
    now: () => NOW,
    onLog: vi.fn(),
    timeZone: 'Europe/Zurich',
    ...overrides,
  };
  return { deps, jobs, savedSyntheses };
}

describe('seedDemo', () => {
  it('fills items, brain, jobs and varied approvals on the enabled agent', async () => {
    const { deps, jobs, savedSyntheses } = seedDeps();
    const result = await seedDemo(deps);
    expect(result).toEqual({ items: 32, syntheses: 1, jobs: 8, approvals: 6 });
    expect(savedSyntheses).toEqual([
      expect.objectContaining({ entityId: 'E1', sourceCount: 1, jobId: null }),
    ]);
    expect(savedSyntheses[0]?.text).not.toMatch(/\d(?<!cave \d)/);
    expect(deps.bootstrapBrain).toHaveBeenCalledOnce();
    expect(new Set(jobs.map((job) => job.agentId))).toEqual(new Set(['a-claude']));
    expect(jobs.filter((job) => job.status === 'waiting_approval')).toHaveLength(6);
    expect(vi.mocked(deps.requestApproval).mock.calls.map((call) => call[1])).toEqual([
      'mcp__odoo__timesheet_create',
      'mcp__m365__send-mail',
      'mcp__m365__send-mail',
      'mcp__m365__send-mail',
      'mcp__odoo__timesheet_create',
      'mcp__filesystem__write_file',
    ]);
  });

  it('closes a demo job once its approval is decided', async () => {
    const { deps } = seedDeps();
    await seedDemo(deps);
    await vi.waitFor(() => expect(deps.updateJob).toHaveBeenCalledTimes(6));
    expect(vi.mocked(deps.updateJob).mock.calls[0]?.[1]).toMatchObject({ status: 'done' });
  });

  it('does not add jobs twice when some already exist', async () => {
    const { deps, jobs } = seedDeps({ listJobs: async () => [{ id: 'old' } as Job] });
    expect(await seedDemo(deps)).toEqual({ items: 32, syntheses: 1, jobs: 0, approvals: 0 });
    expect(jobs).toEqual([]);
  });

  it('fails clearly when a demo source is missing', async () => {
    const { deps } = seedDeps({ listConnectors: async () => [connector('c-m365', 'm365')] });
    await expect(seedDemo(deps)).rejects.toThrow('Connecteur de démo odoo absent');
  });
});

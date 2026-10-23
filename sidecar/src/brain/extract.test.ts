import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RoutingRule } from '@regis/shared';
import { makeAgent } from '../agents/test-support';
import type { AgentDriver } from '../agents/driver';
import { createMemoryJobStore, type MemoryJobStore } from '../jobs/test-support';
import { JobRunner } from '../jobs/runner';
import type { RoutingContext } from '../routing/engine';
import {
  ExtractionFormatError,
  buildExtractionPrompt,
  extractFacts,
  parseExtractionText,
  isExtractableItem,
  pickExtractionAgent,
  validateExtraction,
  type ExtractionDeps,
} from './extract';
import { listPendingSources } from './service';
import { createMemoryBrainStore, makeEntity, makeItem, type MemoryBrainStore } from './test-support';

const atelier = makeEntity({ id: 'E-atelier', kind: 'client', name: 'Atelier Rhône SA' });
const ligne3 = makeEntity({ id: 'E-ligne3', kind: 'project', name: 'Ligne 3' });
const SOURCE = { type: 'item', id: 'm1', text: 'Merci de nous envoyer les offres en PDF signé.' } as const;

const local = makeAgent({ id: 'local', runtime: 'ollama', isLocalOnly: true });

function replying(resultText: string): AgentDriver {
  return {
    runtime: 'ollama',
    run: async function* () {
      await Promise.resolve();
      yield { type: 'start' };
      yield { type: 'end', resultText, isError: false };
    },
    test: () => Promise.resolve({ ok: true, latencyMs: 0, costUsd: 0 }),
  };
}

interface Harness {
  deps: ExtractionDeps;
  brain: MemoryBrainStore;
  jobs: MemoryJobStore;
  dir: string;
}

let harness: Harness | undefined;

function build(resultText: string): Harness {
  const jobs = createMemoryJobStore();
  const brain = createMemoryBrainStore();
  brain.entities = [atelier, ligne3];
  const dir = mkdtempSync(join(tmpdir(), 'regis-extract-'));
  const runner = new JobRunner({
    store: jobs,
    getAgent: (id) => Promise.resolve(id === local.id ? local : undefined),
    getDriver: () => replying(resultText),
    getSetting: () => Promise.resolve(null),
    getDataDir: () => Promise.resolve(dir),
    onLog: () => undefined,
  });
  const deps: ExtractionDeps = {
    runner,
    pickAgent: () => Promise.resolve({ agentId: local.id, reason: 'test' }),
    store: brain,
    failJob: async (jobId, error) => {
      await jobs.updateJob(jobId, { status: 'failed', error });
    },
  };
  harness = { deps, brain, jobs, dir };
  return harness;
}

beforeEach(() => {
  harness = undefined;
});

afterEach(() => {
  if (harness) {
    rmSync(harness.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

describe('validateExtraction', () => {
  it('accepts a list of facts or an object wrapping it', () => {
    const fact = { entityName: 'Atelier', text: 'Paie à 45 jours', status: 'to_verify' };

    expect(validateExtraction([fact])).toEqual([fact]);
    expect(validateExtraction({ facts: [fact] })).toEqual([fact]);
    expect(validateExtraction([])).toEqual([]);
  });

  it.each([
    ['a string', 'oops'],
    ['an object without facts', { entityName: 'A' }],
    ['a missing text', [{ entityName: 'A', status: 'inferred' }]],
    ['an empty entity name', [{ entityName: ' ', text: 't', status: 'inferred' }]],
    ['an unknown status', [{ entityName: 'A', text: 't', status: 'maybe' }]],
    ['a status the model may never grant', [{ entityName: 'A', text: 't', status: 'confirmed' }]],
  ])('rejects %s', (_label, raw) => {
    expect(() => validateExtraction(raw)).toThrow(ExtractionFormatError);
  });
});

describe('parseExtractionText', () => {
  it('finds the JSON inside surrounding prose', () => {
    const text = 'Voici :\n[{"entityName":"A","text":"t","status":"inferred"}]\nFin.';

    expect(parseExtractionText(text)).toHaveLength(1);
  });

  it('rejects text without JSON or with broken JSON', () => {
    expect(() => parseExtractionText('rien à signaler')).toThrow(ExtractionFormatError);
    expect(() => parseExtractionText('[{"entityName":')).toThrow(ExtractionFormatError);
  });
});

describe('extractFacts', () => {
  it('stores the returned facts with the processed source and the returned status', async () => {
    const reply = JSON.stringify([
      { entityName: 'Atelier Rhône SA', text: 'Préfère les offres en PDF signé', status: 'inferred' },
      { entityName: 'Ligne 3', text: 'Recette prévue en décembre', status: 'to_verify' },
    ]);
    const { deps, brain, jobs } = build(reply);

    const created = await extractFacts(SOURCE, [atelier, ligne3], deps);

    expect(created).toHaveLength(2);
    expect(brain.facts).toEqual([
      expect.objectContaining({
        entityId: 'E-atelier',
        sourceType: 'item',
        sourceId: 'm1',
        status: 'inferred',
      }),
      expect.objectContaining({
        entityId: 'E-ligne3',
        sourceType: 'item',
        sourceId: 'm1',
        status: 'to_verify',
      }),
    ]);
    const [job] = [...jobs.jobs.values()];
    expect(job).toMatchObject({ kind: 'extract', status: 'done', agentId: 'local' });
    expect(brain.links).toEqual([
      expect.objectContaining({ fromType: 'job', fromId: job?.id, toId: 'E-atelier' }),
      expect.objectContaining({ fromType: 'job', fromId: job?.id, toId: 'E-ligne3' }),
    ]);
  });

  it('ignores an entity name unknown to the candidates without creating an entity', async () => {
    const reply = JSON.stringify([
      { entityName: 'Fonderie Venoge', text: 'Inactive depuis 64 jours', status: 'inferred' },
    ]);
    const { deps, brain } = build(reply);

    const created = await extractFacts(SOURCE, [atelier], deps);

    expect(created).toEqual([]);
    expect(brain.facts).toEqual([]);
    expect(brain.entities).toHaveLength(2);
  });

  it('never grants the confirmed status to an extracted fact', async () => {
    const { deps, brain } = build(JSON.stringify([{ entityName: 'Ligne 3', text: 'x', status: 'inferred' }]));

    await extractFacts(SOURCE, [ligne3], deps);

    expect(brain.facts.every((fact) => fact.status !== 'confirmed')).toBe(true);
  });

  it('fails the job and writes no fact when the output does not match the format', async () => {
    const { deps, brain, jobs } = build('[{"entityName":"Ligne 3","text":"x","status":"confirmed"}]');

    await expect(extractFacts(SOURCE, [ligne3], deps)).rejects.toBeInstanceOf(ExtractionFormatError);

    expect(brain.facts).toEqual([]);
    const [job] = [...jobs.jobs.values()];
    expect(job?.status).toBe('failed');
    expect(job?.error).toContain('invalide');
  });

  it('skips a fact whose normalized text already exists for the entity', async () => {
    const reply = JSON.stringify([
      { entityName: 'Atelier Rhône SA', text: 'Paie  à 45 JOURS', status: 'inferred' },
      { entityName: 'Atelier Rhône SA', text: 'Paie à 45 jours', status: 'inferred' },
    ]);
    const { deps, brain } = build(reply);
    await brain.addFact({
      entityId: 'E-atelier',
      text: 'paie à 45 jours',
      sourceType: 'item',
      sourceId: 'older',
      status: 'confirmed',
    });

    const created = await extractFacts(SOURCE, [atelier], deps);

    expect(created).toEqual([]);
    expect(brain.facts).toHaveLength(1);
  });

  it('reports a job failure without touching the facts', async () => {
    const { deps, brain } = build('');
    const failing: ExtractionDeps = {
      ...deps,
      pickAgent: () => Promise.resolve({ agentId: 'ghost', reason: 'test' }),
    };

    await expect(extractFacts(SOURCE, [atelier], failing)).rejects.toThrow();

    expect(brain.facts).toEqual([]);
  });
});

describe('buildExtractionPrompt', () => {
  it('lists the candidate entities and clips very long sources', () => {
    const prompt = buildExtractionPrompt({ ...SOURCE, text: 'x'.repeat(10_000) }, [atelier]);

    expect(prompt).toContain('- Atelier Rhône SA (client)');
    expect(prompt.length).toBeLessThan(7_000);
  });
});

describe('pickExtractionAgent', () => {
  const context: RoutingContext = {
    clientIds: [],
    projectIds: [],
    entityTags: [],
    taskType: 'extraction',
    now: new Date('2026-03-01T10:00:00Z'),
    budgetRemainingPct: {},
  };
  const remote = makeAgent({ id: 'remote', runtime: 'anthropic-api', isLocalOnly: false });
  const rule = (agentId: string): RoutingRule => ({
    id: 'r1',
    ord: 0,
    conditionsJson: { taskType: 'extraction' },
    agentId,
    reason: 'volume',
    enabled: true,
  });

  it('defaults to the local agent when no rule applies', () => {
    expect(pickExtractionAgent(context, [], [remote, local])).toMatchObject({ agentId: 'local' });
  });

  it('only leaves the local agent through an explicit rule', () => {
    expect(pickExtractionAgent(context, [rule('remote')], [remote, local])).toMatchObject({
      agentId: 'remote',
      ruleId: 'r1',
    });
  });

  it('ignores catch-all and generic rules that would send the facts to a remote agent', () => {
    const catchAll: RoutingRule = { ...rule('remote'), conditionsJson: {} };
    const otherType: RoutingRule = { ...rule('remote'), conditionsJson: { taskType: 'summary' } };
    const bySource: RoutingRule = { ...rule('remote'), conditionsJson: { source: 'extraction' } };

    expect(pickExtractionAgent(context, [catchAll, otherType, bySource], [remote, local])).toMatchObject({
      agentId: 'local',
      ruleId: null,
    });
  });

  it('returns nothing when no local agent is available', () => {
    expect(pickExtractionAgent(context, [], [remote])).toBeNull();
  });
});

describe('transcript notes', () => {
  it('are not sent to fact extraction while a free note still is', async () => {
    const store = createMemoryBrainStore({
      items: [
        makeItem({
          id: 'n-transcript',
          kind: 'note',
          title: 'Point client',
          bodyText: '**[00:00:00] Moi** : bonjour',
          dataJson: { noteType: 'transcript', status: 'done' },
        }),
        makeItem({ id: 'n-free', kind: 'note', title: 'Idée', bodyText: 'Relancer le client' }),
      ],
    });
    store.entities = [atelier];
    store.links = ['n-transcript', 'n-free'].map((id) => ({
      id: `l-${id}`,
      fromType: 'item',
      fromId: id,
      toType: 'entity',
      toId: atelier.id,
      rel: 'about',
      origin: 'auto',
      confidence: null,
      createdAt: '2026-03-01T10:00:00.000Z',
    }));

    const pending = await listPendingSources(store);

    expect(pending.map((entry) => entry.source.id)).toEqual(['n-free']);
    expect(isExtractableItem({ dataJson: { noteType: 'transcript' } })).toBe(false);
    expect(isExtractableItem({ dataJson: {} })).toBe(true);
  });
});

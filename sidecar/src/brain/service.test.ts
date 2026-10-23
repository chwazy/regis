import { describe, expect, it, vi } from 'vitest';
import type { Fact } from '@regis/shared';
import { ExtractionFormatError, type ExtractionSource } from './extract';
import { BrainService, MAX_EXTRACTIONS_SETTING, listPendingSources } from './service';
import {
  createMemoryBrainStore,
  makeEntity,
  makeFile,
  makeItem,
  type MemoryBrainStore,
} from './test-support';

const atelier = makeEntity({ id: 'E-atelier', kind: 'client', name: 'Atelier Rhône SA' });

function linkedMail(store: MemoryBrainStore, id: string, occurredAt: string): void {
  store.items.push(makeItem({ id, kind: 'message', title: `Mail ${id}`, occurredAt, bodyText: 'contenu' }));
  store.links.push({
    id: `L-${id}`,
    fromType: 'item',
    fromId: id,
    toType: 'entity',
    toId: 'E-atelier',
    rel: 'about',
    origin: 'auto',
    confidence: 0.9,
    createdAt: occurredAt,
  });
}

function setup(limit: string, clock: { now: Date }) {
  const store = createMemoryBrainStore();
  store.entities = [atelier];
  store.settings.set(MAX_EXTRACTIONS_SETTING, limit);
  const processed: string[] = [];
  const extract = vi.fn((source: ExtractionSource): Promise<Fact[]> => {
    processed.push(source.id);
    return Promise.resolve([]);
  });
  const service = new BrainService({ store, extract, now: () => clock.now, onLog: () => undefined });
  return { store, service, processed, extract };
}

describe('daily extraction cap', () => {
  it('leaves the sources beyond the cap queued for the next day, newest first', async () => {
    const clock = { now: new Date('2026-03-02T09:00:00Z') };
    const { store, service, processed } = setup('2', clock);
    linkedMail(store, 'm-old', '2026-02-01T08:00:00.000Z');
    linkedMail(store, 'm-mid', '2026-02-15T08:00:00.000Z');
    linkedMail(store, 'm-new', '2026-02-28T08:00:00.000Z');

    const today = await service.extractPending();
    const sameDayAgain = await service.extractPending();

    expect(processed).toEqual(['m-new', 'm-mid']);
    expect(today).toMatchObject({ processed: 2, pending: 1 });
    expect(sameDayAgain.processed).toBe(0);
    expect(processed).toHaveLength(2);

    clock.now = new Date('2026-03-03T09:00:00Z');
    const nextDay = await service.extractPending();

    expect(processed).toEqual(['m-new', 'm-mid', 'm-old']);
    expect(nextDay).toMatchObject({ processed: 1, pending: 0 });
  });

  it('counts the calendar day in the configured timezone', async () => {
    const clock = { now: new Date('2026-03-02T22:30:00Z') };
    const { store, service, processed } = setup('1', clock);
    store.settings.set('app.timezone', 'Europe/Zurich');
    linkedMail(store, 'm1', '2026-02-01T08:00:00.000Z');
    linkedMail(store, 'm2', '2026-02-02T08:00:00.000Z');

    await service.extractPending();
    clock.now = new Date('2026-03-02T22:59:00Z');
    await service.extractPending();
    expect(processed).toHaveLength(1);

    clock.now = new Date('2026-03-02T23:01:00Z');
    await service.extractPending();
    expect(processed).toHaveLength(2);
  });
});

describe('listPendingSources', () => {
  it('only offers linked items and file chunks that were not processed yet', async () => {
    const store = createMemoryBrainStore({
      files: [makeFile({ id: 'f1', mtime: '2026-02-20T00:00:00.000Z' })],
    });
    store.entities = [atelier];
    linkedMail(store, 'm1', '2026-02-10T08:00:00.000Z');
    store.items.push(makeItem({ id: 'orphan', kind: 'message' }));
    store.links.push({
      id: 'L-f1',
      fromType: 'file',
      fromId: 'f1',
      toType: 'entity',
      toId: 'E-atelier',
      rel: 'about',
      origin: 'user',
      confidence: null,
      createdAt: '',
    });
    store.chunks.set('file:f1', [
      { id: 7, text: 'premier' },
      { id: 8, text: 'second' },
    ]);
    store.settings.set('brain.extracted.chunk.7', 'done');

    const pending = await listPendingSources(store);

    expect(pending.map((entry) => entry.ledgerKey)).toEqual(['chunk.8', 'item.m1']);
    expect(pending[0]?.source).toEqual({ type: 'chunk', id: '8', text: 'second' });
    expect(pending[0]?.candidates.map((entity) => entity.id)).toEqual(['E-atelier']);
  });
});

describe('extraction outcomes', () => {
  it('marks a source with an unusable answer as failed and does not retry it', async () => {
    const clock = { now: new Date('2026-03-02T09:00:00Z') };
    const { store, service, extract } = setup('10', clock);
    linkedMail(store, 'm1', '2026-02-01T08:00:00.000Z');
    extract.mockRejectedValueOnce(new ExtractionFormatError('bad'));

    const first = await service.extractPending();
    const second = await service.extractPending();

    expect(first).toMatchObject({ processed: 0, failed: 1, pending: 0 });
    expect(second.pending).toBe(0);
    expect(extract).toHaveBeenCalledTimes(1);
  });

  it('stops the cycle on an infrastructure error and keeps the source queued', async () => {
    const clock = { now: new Date('2026-03-02T09:00:00Z') };
    const { store, service, extract } = setup('10', clock);
    linkedMail(store, 'm1', '2026-02-01T08:00:00.000Z');
    linkedMail(store, 'm2', '2026-02-02T08:00:00.000Z');
    linkedMail(store, 'm3', '2026-02-03T08:00:00.000Z');
    linkedMail(store, 'm4', '2026-02-04T08:00:00.000Z');
    extract.mockRejectedValueOnce(new Error('ollama down'));

    const report = await service.extractPending();

    expect(report.pending).toBe(2);
    expect(extract).toHaveBeenCalledTimes(3);
    expect(store.settings.get('brain.extracted.item.m4')).toBeUndefined();
    expect(store.settings.get('brain.extracted.item.m1')).toBeUndefined();
  });
});

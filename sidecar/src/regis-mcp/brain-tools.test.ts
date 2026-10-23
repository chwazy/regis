import { describe, expect, it } from 'vitest';
import type { EntityCard } from '@regis/shared';
import { createMemoryBrainStore, makeEntity } from '../brain/test-support';
import { createBrainTools } from './brain-tools';

const atelier = makeEntity({ id: 'E-atelier', kind: 'client', name: 'Atelier Rhône SA' });

const card: EntityCard = {
  entity: atelier,
  synthesis: null,
  stats: { hoursLast30Days: 0, lastMessageAt: null },
  notes: [],
  facts: [
    {
      fact: {
        id: 'F1',
        entityId: 'E-atelier',
        text: 'Paie à 45 jours',
        sourceType: 'item',
        sourceId: 'm1',
        status: 'inferred',
        createdAt: '',
      },
      source: { kind: 'item', id: 'm1', label: 'Re: Facture', fileId: null },
    },
  ],
  projects: [],
  documents: [],
  timeline: [],
  links: [],
  activeJobs: [],
};

function setup() {
  const store = createMemoryBrainStore();
  store.entities = [atelier];
  const tools = createBrainTools({
    search: (query) =>
      Promise.resolve({
        entities: query.toLowerCase().startsWith('atel') ? [atelier] : [],
        documents: [],
        mails: [],
        notes: [],
      }),
    getEntityCard: (id) =>
      id === 'E-atelier' ? Promise.resolve(card) : Promise.reject(new Error('missing')),
    store,
  });
  return { store, tools };
}

describe('brain tools', () => {
  it('searches entities, documents and mails', async () => {
    const { tools } = setup();

    const result = await tools.search({ query: 'Atelier' });

    expect(result.isError).toBe(false);
    expect(result.payload).toMatchObject({
      entities: [{ id: 'E-atelier', kind: 'client', name: 'Atelier Rhône SA' }],
    });
    expect((await tools.search({ query: '' })).isError).toBe(true);
  });

  it('returns the sourced facts of an entity and refuses unknown ids', async () => {
    const { tools } = setup();

    const found = await tools.getEntity({ entityId: 'E-atelier' });
    const missing = await tools.getEntity({ entityId: 'nope' });

    expect(found.payload).toMatchObject({
      facts: [{ id: 'F1', status: 'inferred', source: 'Re: Facture' }],
    });
    expect(missing.isError).toBe(true);
  });

  it('records an inferred fact sourced to the calling job and ignores duplicates', async () => {
    const { store, tools } = setup();

    const first = await tools.addFact(
      { jobId: 'J1', agentId: 'a1' },
      { entityId: 'E-atelier', text: 'Aime le PDF' },
    );
    const again = await tools.addFact(
      { jobId: 'J2', agentId: 'a1' },
      { entityId: 'E-atelier', text: 'aime  le pdf' },
    );

    expect(first.payload).toMatchObject({ status: 'inferred', duplicate: false });
    expect(again.payload).toMatchObject({ duplicate: true });
    expect(store.facts).toEqual([
      expect.objectContaining({ sourceType: 'job', sourceId: 'J1', status: 'inferred' }),
    ]);
  });

  it('refuses a fact without a calling job or for an unknown entity', async () => {
    const { store, tools } = setup();

    const noJob = await tools.addFact({ jobId: '', agentId: 'a1' }, { entityId: 'E-atelier', text: 'x' });
    const noEntity = await tools.addFact({ jobId: 'J1', agentId: 'a1' }, { entityId: 'nope', text: 'x' });

    expect(noJob.isError).toBe(true);
    expect(noEntity.isError).toBe(true);
    expect(store.facts).toEqual([]);
  });
});

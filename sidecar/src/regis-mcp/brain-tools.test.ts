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
  resources: [],
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

  it('creates an entity once and returns the existing one on a same-name retry', async () => {
    const { store, tools } = setup();

    const created = await tools.createEntity({ kind: 'contact', name: 'Marie Dupont', tags: ['achats'] });
    const again = await tools.createEntity({ kind: 'contact', name: '  marie dupont ' });
    const sameNameOtherKind = await tools.createEntity({ kind: 'client', name: 'Marie Dupont' });
    const invalid = await tools.createEntity({ kind: 'supplier', name: 'X' });

    expect(created.payload).toMatchObject({
      entity: { kind: 'contact', name: 'Marie Dupont' },
      duplicate: false,
    });
    expect(again.payload).toMatchObject({ duplicate: true });
    expect(sameNameOtherKind.payload).toMatchObject({ duplicate: false });
    expect(invalid.isError).toBe(true);
    expect(store.entities.filter((entity) => entity.name === 'Marie Dupont')).toHaveLength(2);
  });

  it('updates an entity and refuses an empty change or an unknown id', async () => {
    const { tools } = setup();

    const renamed = await tools.updateEntity({ entityId: 'E-atelier', name: 'Atelier Rhône', tags: ['vip'] });
    const empty = await tools.updateEntity({ entityId: 'E-atelier' });
    const missing = await tools.updateEntity({ entityId: 'nope', name: 'X' });

    expect(renamed.payload).toMatchObject({ entity: { name: 'Atelier Rhône', tags: ['vip'] } });
    expect(empty.isError).toBe(true);
    expect(missing.isError).toBe(true);
  });

  it('links two entities without duplicating the link', async () => {
    const { store, tools } = setup();
    const contact = await store.saveEntity({ kind: 'contact', name: 'Marie' });

    const first = await tools.linkEntities({
      fromEntityId: contact.id,
      toEntityId: 'E-atelier',
      rel: 'belongs_to',
    });
    const again = await tools.linkEntities({
      fromEntityId: contact.id,
      toEntityId: 'E-atelier',
      rel: 'belongs_to',
    });

    expect(first.payload).toEqual({ linked: true, duplicate: false });
    expect(again.payload).toEqual({ linked: true, duplicate: true });
    expect(store.links).toEqual([
      expect.objectContaining({
        fromType: 'entity',
        fromId: contact.id,
        toId: 'E-atelier',
        rel: 'belongs_to',
      }),
    ]);
  });

  it('confirms a fact and deletes it when rejected', async () => {
    const { store, tools } = setup();
    const fact = await store.addFact({
      entityId: 'E-atelier',
      text: 'Paie à 30 jours',
      sourceType: 'job',
      sourceId: 'J1',
      status: 'inferred',
    });

    const confirmed = await tools.setFactStatus({ factId: fact.id, status: 'confirmed' });
    const rejected = await tools.setFactStatus({ factId: fact.id, status: 'rejected' });
    const missing = await tools.setFactStatus({ factId: 'nope', status: 'confirmed' });

    expect(confirmed.payload).toEqual({ factId: fact.id, status: 'confirmed' });
    expect(rejected.payload).toEqual({ factId: fact.id, deleted: true });
    expect(missing.isError).toBe(true);
    expect(store.facts).toEqual([]);
  });

  it('adds a note to an entity and asks the brain to process it', async () => {
    const store = createMemoryBrainStore();
    store.entities = [atelier];
    let runs = 0;
    const tools = createBrainTools({
      search: () => Promise.resolve({ entities: [], documents: [], mails: [], notes: [] }),
      getEntityCard: () => Promise.resolve(card),
      store,
      onNoteAdded: () => {
        runs += 1;
      },
    });

    const added = await tools.addNote({ entityId: 'E-atelier', text: 'Préfère les rendez-vous le matin' });

    expect(added.isError).toBe(false);
    expect(runs).toBe(1);
    expect(store.items).toEqual([expect.objectContaining({ kind: 'note' })]);
    expect(store.links).toEqual([
      expect.objectContaining({ fromType: 'item', toId: 'E-atelier', rel: 'about' }),
    ]);
  });
  it('attaches project resources once, shows them on the entity and removes them', async () => {
    const { store, tools } = setup();

    const repo = await tools.addResource({
      entityId: 'E-atelier',
      kind: 'repo',
      value: 'D:/git/atelier',
      label: 'Checkout',
    });
    const again = await tools.addResource({ entityId: 'E-atelier', kind: 'repo', value: ' D:/git/atelier ' });
    const unknownKind = await tools.addResource({ entityId: 'E-atelier', kind: 'secret', value: 'x' });
    const unknownEntity = await tools.addResource({ entityId: 'nope', kind: 'remote', value: 'https://x' });
    const resourceId = (repo.payload as { resourceId: string }).resourceId;

    expect(repo.payload).toMatchObject({ kind: 'repo', value: 'D:/git/atelier' });
    expect((again.payload as { resourceId: string }).resourceId).toBe(resourceId);
    expect(unknownKind.isError).toBe(true);
    expect(unknownEntity.isError).toBe(true);
    expect(store.resources).toHaveLength(1);

    expect((await tools.removeResource({ resourceId })).payload).toEqual({ resourceId, deleted: true });
    expect((await tools.removeResource({ resourceId })).isError).toBe(true);
  });
});

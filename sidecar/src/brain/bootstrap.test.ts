import { describe, expect, it } from 'vitest';
import { bootstrapFromOdoo, formatHours, ODOO_HOURS_FACT_PREFIX } from './bootstrap';
import { createMemoryBrainStore, makeItem } from './test-support';

const CONNECTOR = 'c-odoo';

const odooItem = (kind: 'partner' | 'project' | 'time_entry', id: string, title: string, dataJson: object) =>
  makeItem({ id: `${kind}-${id}`, kind, externalId: id, connectorId: CONNECTOR, title, dataJson });

const fixtureItems = () => [
  odooItem('partner', '10', 'Atelier Rhône SA', {
    email: 'info@atelier-rhone.ch',
    isCompany: true,
    parent: null,
  }),
  odooItem('partner', '11', 'Laiterie du Jorat', { email: null, isCompany: true, parent: null }),
  odooItem('project', '1', 'Ligne 3 — extension', { partner: { id: 10, name: 'Atelier Rhône SA' } }),
  odooItem('project', '2', 'Maintenance supervision', { partner: { id: 10, name: 'Atelier Rhône SA' } }),
  odooItem('project', '3', 'Offre fromagerie', { partner: { id: 11, name: 'Laiterie du Jorat' } }),
];

describe('bootstrapFromOdoo', () => {
  it('creates a client entity per customer and a project entity linked to its client', async () => {
    const store = createMemoryBrainStore({ items: fixtureItems() });

    const result = await bootstrapFromOdoo(store);

    const clients = store.entities.filter((entity) => entity.kind === 'client');
    const projects = store.entities.filter((entity) => entity.kind === 'project');
    expect(clients.map((entity) => entity.name)).toEqual(['Atelier Rhône SA', 'Laiterie du Jorat']);
    expect(projects).toHaveLength(3);
    expect(result).toMatchObject({ clients: 2, projects: 3, contacts: 0, links: 3 });
    const clientOf = (projectName: string): string | undefined => {
      const project = projects.find((entity) => entity.name === projectName);
      const link = store.links.find((candidate) => candidate.fromId === project?.id);
      expect(link).toMatchObject({ rel: 'belongs_to', toType: 'entity', origin: 'auto' });
      return store.entities.find((entity) => entity.id === link?.toId)?.name;
    };
    expect(clientOf('Ligne 3 — extension')).toBe('Atelier Rhône SA');
    expect(clientOf('Maintenance supervision')).toBe('Atelier Rhône SA');
    expect(clientOf('Offre fromagerie')).toBe('Laiterie du Jorat');
  });

  it('does not create duplicates when run again', async () => {
    const store = createMemoryBrainStore({ items: fixtureItems() });

    await bootstrapFromOdoo(store);
    const second = await bootstrapFromOdoo(store);

    expect(store.entities).toHaveLength(5);
    expect(store.links).toHaveLength(3);
    expect(second).toMatchObject({ clients: 0, projects: 0, contacts: 0, links: 0 });
  });

  it('keys entities on the connector and the Odoo id, and follows a rename', async () => {
    const items = fixtureItems();
    const store = createMemoryBrainStore({ items });
    await bootstrapFromOdoo(store);

    store.items = items.map((item) =>
      item.id === 'partner-10' ? { ...item, title: 'Atelier Rhône Sàrl' } : item,
    );
    await bootstrapFromOdoo(store);

    expect(store.entities).toHaveLength(5);
    expect(store.entities.map((entity) => entity.name)).toContain('Atelier Rhône Sàrl');
    expect(store.entities[0]?.dataJson).toMatchObject({ connectorId: CONNECTOR, externalId: '10' });
  });

  it('keeps a category changed by the user when Odoo data changes', async () => {
    const items = fixtureItems();
    const store = createMemoryBrainStore({ items });
    await bootstrapFromOdoo(store);
    store.entities = store.entities.map((entity) =>
      entity.name === 'Laiterie du Jorat' ? { ...entity, kind: 'other' } : entity,
    );

    store.items = items.map((item) =>
      item.id === 'partner-11' ? { ...item, title: 'Laiterie du Jorat SA' } : item,
    );
    await bootstrapFromOdoo(store);

    expect(store.entities.find((entity) => entity.name === 'Laiterie du Jorat SA')?.kind).toBe('other');
  });

  it('attaches a contact person to the company they belong to', async () => {
    const store = createMemoryBrainStore({
      items: [
        ...fixtureItems(),
        odooItem('partner', '12', 'M. Keller', {
          email: 'keller@atelier-rhone.ch',
          isCompany: false,
          parent: { id: 10, name: 'Atelier Rhône SA' },
        }),
      ],
    });

    const result = await bootstrapFromOdoo(store);

    const keller = store.entities.find((entity) => entity.name === 'M. Keller');
    const company = store.entities.find((entity) => entity.name === 'Atelier Rhône SA');
    expect(keller).toMatchObject({ kind: 'contact', dataJson: { email: 'keller@atelier-rhone.ch' } });
    expect(result.contacts).toBe(1);
    expect(store.links).toContainEqual(
      expect.objectContaining({ fromId: keller?.id, toId: company?.id, rel: 'belongs_to' }),
    );
  });

  it('records the hours logged on Odoo as a confirmed fact sourced to the project and refreshes it', async () => {
    const entry = (id: string, hours: number) =>
      odooItem('time_entry', id, 'Câblage', { hours, project: { id: 1, name: 'Ligne 3 — extension' } });
    const store = createMemoryBrainStore({ items: [...fixtureItems(), entry('t1', 3.5), entry('t2', 1)] });

    await bootstrapFromOdoo(store);
    const project = store.entities.find((entity) => entity.name === 'Ligne 3 — extension');
    expect(store.facts).toEqual([
      expect.objectContaining({
        entityId: project?.id,
        text: `${ODOO_HOURS_FACT_PREFIX}4 h 30`,
        sourceType: 'item',
        sourceId: 'project-1',
        status: 'confirmed',
      }),
    ]);

    await bootstrapFromOdoo(store);
    expect(store.facts).toHaveLength(1);

    store.items = [...store.items, entry('t3', 2)];
    await bootstrapFromOdoo(store);
    expect(store.facts.map((fact) => fact.text)).toEqual([`${ODOO_HOURS_FACT_PREFIX}6 h 30`]);
  });
});

describe('formatHours', () => {
  it('writes whole hours and minutes', () => {
    expect(formatHours(46.5)).toBe('46 h 30');
    expect(formatHours(12)).toBe('12 h');
    expect(formatHours(1.999)).toBe('2 h');
  });
});

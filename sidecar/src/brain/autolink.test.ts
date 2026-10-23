import { describe, expect, it } from 'vitest';
import {
  AUTOLINK_MIN_CONFIDENCE,
  proposeFileLinks,
  proposeLinks,
  runAutolink,
  withClientRefs,
  writeAutoLinks,
  type LinkProposal,
} from './autolink';
import { createMemoryBrainStore, makeEntity, makeFile, makeItem } from './test-support';

const atelier = makeEntity({
  id: 'E-atelier',
  kind: 'client',
  name: 'Atelier Rhône SA',
  dataJson: {
    connectorId: 'c-odoo',
    sourceKind: 'partner',
    externalId: '10',
    email: 'info@atelier-rhone.ch',
  },
});
const laiterie = makeEntity({ id: 'E-laiterie', kind: 'client', name: 'Laiterie du Jorat' });
const ligne3 = makeEntity({
  id: 'E-ligne3',
  kind: 'project',
  name: 'Ligne 3 extension',
  dataJson: { connectorId: 'c-odoo', sourceKind: 'project', externalId: '1' },
});
const keller = makeEntity({
  id: 'E-keller',
  kind: 'contact',
  name: 'M. Keller',
  dataJson: { email: 'keller@atelier-rhone.ch', clientEntityIds: ['E-atelier'] },
});
const entities = [atelier, laiterie, ligne3];

const mail = (overrides: Partial<Parameters<typeof makeItem>[0]> = {}) =>
  makeItem({
    id: 'm1',
    kind: 'message',
    title: 'Question',
    dataJson: { from: { name: 'M. Keller', address: 'keller@atelier-rhone.ch' }, to: [] },
    ...overrides,
  });

describe('proposeLinks', () => {
  it('proposes the client of a contact whose address sent the mail', () => {
    const proposals = proposeLinks(mail(), entities, [keller]);

    const toClient = proposals.find((proposal) => proposal.toEntityId === 'E-atelier');
    expect(toClient).toMatchObject({ fromType: 'item', fromId: 'm1', rel: 'about' });
    expect(toClient?.confidence).toBeGreaterThanOrEqual(AUTOLINK_MIN_CONFIDENCE);
    expect(proposals.find((proposal) => proposal.toEntityId === 'E-keller')).toMatchObject({ rel: 'from' });
  });

  it('proposes nothing for a mail that matches no entity', () => {
    const stranger = mail({
      title: 'Newsletter',
      dataJson: { from: { name: 'Promo', address: 'promo@shop.example' }, to: [] },
    });

    expect(proposeLinks(stranger, entities, [keller])).toEqual([]);
  });

  it('matches the sender domain of a client with a lower confidence than an exact address', () => {
    const colleague = mail({
      dataJson: { from: { name: 'Autre', address: 'compta@atelier-rhone.ch' }, to: [] },
    });

    const proposals = proposeLinks(colleague, entities, [keller]);

    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ toEntityId: 'E-atelier', confidence: 0.7 });
  });

  it('ignores free mail domains', () => {
    const personal = makeEntity({
      id: 'E-perso',
      kind: 'client',
      name: 'Particulier',
      dataJson: { email: 'jean@gmail.com' },
    });
    const other = mail({ dataJson: { from: { name: 'X', address: 'x@gmail.com' }, to: [] } });

    expect(proposeLinks(other, [personal], [])).toEqual([]);
  });

  it('finds a project name in the title', () => {
    const proposals = proposeLinks(
      mail({ title: 'Re: Ligne 3 extension - planning', dataJson: { from: null, to: [] } }),
      entities,
      [],
    );

    expect(proposals).toEqual([
      expect.objectContaining({ toEntityId: 'E-ligne3', rel: 'about', confidence: 0.75 }),
    ]);
  });

  it('follows the Odoo references of an item to its client and project', () => {
    const entry = makeItem({
      id: 't1',
      kind: 'time_entry',
      connectorId: 'c-odoo',
      dataJson: { hours: 2, project: { id: 1, name: 'Ligne 3' } },
    });
    const invoice = makeItem({
      id: 'i1',
      kind: 'invoice',
      connectorId: 'c-odoo',
      dataJson: { partner: { id: 10, name: 'Atelier Rhône SA' } },
    });

    expect(proposeLinks(entry, entities, [])).toEqual([
      expect.objectContaining({ toEntityId: 'E-ligne3', confidence: 0.95 }),
    ]);
    expect(proposeLinks(invoice, entities, [])).toEqual([
      expect.objectContaining({ toEntityId: 'E-atelier', confidence: 0.95 }),
    ]);
  });

  it('does not link the Odoo master records themselves', () => {
    const partner = makeItem({ id: 'p1', kind: 'partner', title: 'Atelier Rhône SA' });

    expect(proposeLinks(partner, entities, [])).toEqual([]);
  });

  it('keeps the strongest proposal per target', () => {
    const proposals = proposeLinks(mail({ title: 'Atelier Rhône SA - offre' }), entities, [keller]);

    expect(proposals.filter((proposal) => proposal.toEntityId === 'E-atelier')).toHaveLength(1);
    expect(proposals.find((proposal) => proposal.toEntityId === 'E-atelier')?.confidence).toBe(0.9);
  });
});

describe('proposeFileLinks', () => {
  it('links a file whose path mentions a project or a client', () => {
    const file = makeFile({ id: 'f1', relPath: 'clients/Atelier Rhone SA/Ligne 3 extension/cahier.pdf' });

    const proposals = proposeFileLinks(file, entities);

    expect(proposals.map((proposal) => proposal.toEntityId).sort()).toEqual(['E-atelier', 'E-ligne3']);
    expect(proposals.every((proposal) => proposal.fromType === 'file')).toBe(true);
  });
});

describe('writing links', () => {
  it('writes only the proposals above the minimum confidence', async () => {
    const store = createMemoryBrainStore();
    const proposal = (toEntityId: string, confidence: number): LinkProposal => ({
      fromType: 'item',
      fromId: 'm1',
      toEntityId,
      rel: 'about',
      confidence,
      reason: toEntityId,
    });

    const written = await writeAutoLinks(store, [
      proposal('E-a', 0.9),
      proposal('E-b', 0.55),
      proposal('E-c', 0.6),
    ]);

    expect(written).toBe(2);
    expect(store.links.map((link) => link.toId)).toEqual(['E-a', 'E-c']);
    expect(store.links.every((link) => link.origin === 'auto' && (link.confidence ?? 0) >= 0.6)).toBe(true);
  });

  it('links new mails and files once and leaves existing links alone', async () => {
    const store = createMemoryBrainStore({
      items: [mail(), mail({ id: 'm2', title: 'Newsletter', dataJson: { from: null, to: [] } })],
      files: [makeFile({ id: 'f1', relPath: 'Atelier Rhone SA/offre.pdf' })],
    });
    store.entities = [atelier, laiterie, ligne3, keller];
    store.links = [
      {
        id: 'L-bc',
        fromType: 'entity',
        fromId: 'E-keller',
        toType: 'entity',
        toId: 'E-atelier',
        rel: 'belongs_to',
        origin: 'auto',
        confidence: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ];

    const first = await runAutolink(store);
    const second = await runAutolink(store);

    expect(first).toBeGreaterThanOrEqual(3);
    expect(second).toBe(0);
    expect(store.links.filter((link) => link.fromId === 'm2')).toEqual([]);
    expect(store.links.some((link) => link.fromType === 'file' && link.toId === 'E-atelier')).toBe(true);
  });
});

describe('withClientRefs', () => {
  it('derives the clients of a contact from the belongs_to links without persisting them', () => {
    const bare = makeEntity({ id: 'E-k', kind: 'contact', name: 'K', dataJson: { email: 'k@x.ch' } });
    const links = [
      {
        id: 'L1',
        fromType: 'entity',
        fromId: 'E-k',
        toType: 'entity',
        toId: 'E-atelier',
        rel: 'belongs_to',
        origin: 'auto',
        confidence: 1,
        createdAt: '',
      },
    ];

    const [enriched] = withClientRefs([bare], links);

    expect(enriched?.dataJson).toMatchObject({ email: 'k@x.ch', clientEntityIds: ['E-atelier'] });
    expect(bare.dataJson).toEqual({ email: 'k@x.ch' });
  });
});

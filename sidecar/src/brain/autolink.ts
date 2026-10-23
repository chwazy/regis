import { z } from 'zod';
import type { Entity, FileEntry, Item, ItemKind, Link, LinkProposalRow } from '@regis/shared';
import {
  CONTACT_CLIENT_IDS_KEY,
  addressDomain,
  containsPhrase,
  readEntityData,
  sourceKey,
  sourceKeyOf,
} from './entity-data';
import type { BrainStore } from './store';

export interface LinkProposal {
  fromType: 'item' | 'file';
  fromId: string;
  toEntityId: string;
  rel: 'about' | 'from' | 'belongs_to';
  confidence: number;
  reason: string;
}

export const AUTOLINK_MIN_CONFIDENCE = 0.6;

const CONFIDENCE = {
  odooReference: 0.95,
  senderAddress: 0.95,
  clientOfContact: 0.9,
  recipientAddress: 0.8,
  domain: 0.7,
  projectInTitle: 0.75,
  clientInTitle: 0.65,
  filePath: 0.7,
} as const;

const MIN_NAME_LENGTH = 4;
const SOURCE_ITEM_KINDS = new Set<ItemKind>(['partner', 'project', 'contact', 'note']);
const LINKABLE_ITEM_KINDS: ItemKind[] = ['message', 'event', 'task', 'time_entry', 'invoice'];
const FREE_MAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'outlook.fr',
  'hotmail.com',
  'hotmail.fr',
  'live.com',
  'yahoo.com',
  'yahoo.fr',
  'icloud.com',
  'me.com',
  'bluewin.ch',
  'gmx.ch',
  'gmx.net',
  'proton.me',
  'protonmail.com',
]);

const person = z.looseObject({ address: z.string().nullish() });
const itemPeople = z.looseObject({
  from: person.nullish(),
  to: z.array(person).nullish(),
  cc: z.array(person).nullish(),
  attendees: z.array(person).nullish(),
});
const odooReferences = z.looseObject({
  partner: z.object({ id: z.number() }).nullish(),
  project: z.object({ id: z.number() }).nullish(),
});

interface Candidate {
  toEntityId: string;
  rel: LinkProposal['rel'];
  confidence: number;
  reason: string;
}

function addresses(people: z.infer<typeof person>[] | null | undefined): string[] {
  return (people ?? []).flatMap((entry) => (entry.address ? [entry.address.trim().toLowerCase()] : []));
}

function clientIdsOf(contact: Entity): string[] {
  return readEntityData(contact)[CONTACT_CLIENT_IDS_KEY] ?? [];
}

function emailOf(entity: Entity): string | null {
  const email = readEntityData(entity).email;
  return email ? email.trim().toLowerCase() : null;
}

function longEnough(entity: Entity): boolean {
  return entity.name.trim().length >= MIN_NAME_LENGTH;
}

function merge(candidates: Candidate[], fromType: 'item' | 'file', fromId: string): LinkProposal[] {
  const best = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const key = `${candidate.toEntityId}|${candidate.rel}`;
    const known = best.get(key);
    if (!known || candidate.confidence > known.confidence) {
      best.set(key, candidate);
    }
  }
  return [...best.values()]
    .sort((left, right) => right.confidence - left.confidence)
    .map((candidate) => ({ fromType, fromId, ...candidate }));
}

function matchPeople(
  addressList: string[],
  sender: boolean,
  clients: Entity[],
  contacts: Entity[],
): Candidate[] {
  const found: Candidate[] = [];
  for (const address of addressList) {
    const domain = addressDomain(address);
    for (const contact of contacts) {
      if (emailOf(contact) === address) {
        found.push({
          toEntityId: contact.id,
          rel: sender ? 'from' : 'about',
          confidence: sender ? CONFIDENCE.senderAddress : CONFIDENCE.recipientAddress,
          reason: `adresse ${address}`,
        });
        for (const clientId of clientIdsOf(contact)) {
          found.push({
            toEntityId: clientId,
            rel: 'about',
            confidence: sender ? CONFIDENCE.clientOfContact : CONFIDENCE.recipientAddress,
            reason: `contact ${contact.name}`,
          });
        }
      }
    }
    if (domain && !FREE_MAIL_DOMAINS.has(domain)) {
      for (const client of clients) {
        const clientEmail = emailOf(client);
        if (clientEmail && addressDomain(clientEmail) === domain) {
          found.push({
            toEntityId: client.id,
            rel: 'about',
            confidence: CONFIDENCE.domain,
            reason: `domaine ${domain}`,
          });
        }
      }
      for (const contact of contacts) {
        const contactEmail = emailOf(contact);
        if (contactEmail && addressDomain(contactEmail) === domain) {
          for (const clientId of clientIdsOf(contact)) {
            found.push({
              toEntityId: clientId,
              rel: 'about',
              confidence: CONFIDENCE.domain,
              reason: `domaine ${domain}`,
            });
          }
        }
      }
    }
  }
  return found;
}

function matchOdooReferences(item: Item, entities: Entity[], contacts: Entity[]): Candidate[] {
  const parsed = odooReferences.safeParse(item.dataJson);
  if (!parsed.success) {
    return [];
  }
  const found: Candidate[] = [];
  const partnerId = parsed.data.partner?.id;
  if (partnerId !== undefined) {
    const key = sourceKey(item.connectorId, 'partner', String(partnerId));
    for (const entity of entities) {
      if (entity.kind === 'client' && sourceKeyOf(entity) === key) {
        found.push({
          toEntityId: entity.id,
          rel: 'about',
          confidence: CONFIDENCE.odooReference,
          reason: 'client Odoo',
        });
      }
    }
    for (const contact of contacts) {
      if (sourceKeyOf(contact) === key) {
        for (const clientId of clientIdsOf(contact)) {
          found.push({
            toEntityId: clientId,
            rel: 'about',
            confidence: CONFIDENCE.clientOfContact,
            reason: 'contact Odoo',
          });
        }
      }
    }
  }
  const projectId = parsed.data.project?.id;
  if (projectId !== undefined) {
    const key = sourceKey(item.connectorId, 'project', String(projectId));
    for (const entity of entities) {
      if (entity.kind === 'project' && sourceKeyOf(entity) === key) {
        found.push({
          toEntityId: entity.id,
          rel: 'about',
          confidence: CONFIDENCE.odooReference,
          reason: 'projet Odoo',
        });
      }
    }
  }
  return found;
}

export function proposeLinks(item: Item, entities: Entity[], contacts: Entity[]): LinkProposal[] {
  if (SOURCE_ITEM_KINDS.has(item.kind)) {
    return [];
  }
  const clients = entities.filter((entity) => entity.kind === 'client');
  const projects = entities.filter((entity) => entity.kind === 'project');
  const people = itemPeople.safeParse(item.dataJson);
  const candidates: Candidate[] = [];
  if (people.success) {
    candidates.push(
      ...matchPeople(addresses(people.data.from ? [people.data.from] : []), true, clients, contacts),
      ...matchPeople(
        [...addresses(people.data.to), ...addresses(people.data.cc), ...addresses(people.data.attendees)],
        false,
        clients,
        contacts,
      ),
    );
  }
  candidates.push(...matchOdooReferences(item, entities, contacts));
  for (const project of projects.filter(longEnough)) {
    if (containsPhrase(item.title, project.name)) {
      candidates.push({
        toEntityId: project.id,
        rel: 'about',
        confidence: CONFIDENCE.projectInTitle,
        reason: `titre mentionne ${project.name}`,
      });
    }
  }
  for (const client of clients.filter(longEnough)) {
    if (containsPhrase(item.title, client.name)) {
      candidates.push({
        toEntityId: client.id,
        rel: 'about',
        confidence: CONFIDENCE.clientInTitle,
        reason: `titre mentionne ${client.name}`,
      });
    }
  }
  return merge(candidates, 'item', item.id);
}

export function proposeFileLinks(file: FileEntry, entities: Entity[]): LinkProposal[] {
  const candidates: Candidate[] = entities
    .filter((entity) => (entity.kind === 'client' || entity.kind === 'project') && longEnough(entity))
    .filter((entity) => containsPhrase(file.relPath, entity.name))
    .map((entity) => ({
      toEntityId: entity.id,
      rel: 'about' as const,
      confidence: CONFIDENCE.filePath,
      reason: `chemin mentionne ${entity.name}`,
    }));
  return merge(candidates, 'file', file.id);
}

export function writableProposals(proposals: LinkProposal[]): LinkProposal[] {
  return proposals.filter((proposal) => proposal.confidence >= AUTOLINK_MIN_CONFIDENCE);
}

export function withClientRefs(contacts: Entity[], links: Link[]): Entity[] {
  return contacts.map((contact) => {
    const clientEntityIds = links
      .filter(
        (link) =>
          link.fromType === 'entity' &&
          link.fromId === contact.id &&
          link.toType === 'entity' &&
          link.rel === 'belongs_to',
      )
      .map((link) => link.toId);
    const data = typeof contact.dataJson === 'object' && contact.dataJson !== null ? contact.dataJson : {};
    return { ...contact, dataJson: { ...data, [CONTACT_CLIENT_IDS_KEY]: clientEntityIds } };
  });
}

function toRow(proposal: LinkProposal): LinkProposalRow {
  return {
    fromType: proposal.fromType,
    fromId: proposal.fromId,
    toEntityId: proposal.toEntityId,
    rel: proposal.rel,
    confidence: proposal.confidence,
  };
}

function linkKey(fromType: string, fromId: string, toId: string, rel: string): string {
  return `${fromType}|${fromId}|${toId}|${rel}`;
}

export async function writeAutoLinks(
  store: Pick<BrainStore, 'insertAutoLinks'>,
  proposals: LinkProposal[],
): Promise<number> {
  return store.insertAutoLinks(writableProposals(proposals).map(toRow));
}

export async function runAutolink(store: BrainStore): Promise<number> {
  const [entities, links, files, ...itemsByKind] = await Promise.all([
    store.listEntities(),
    store.listLinks(),
    store.listFiles(),
    ...LINKABLE_ITEM_KINDS.map((kind) => store.listItems(kind)),
  ]);
  const contacts = withClientRefs(
    entities.filter((entity) => entity.kind === 'contact'),
    links,
  );
  const known = new Set(links.map((link) => linkKey(link.fromType, link.fromId, link.toId, link.rel)));
  const proposals: LinkProposal[] = [
    ...itemsByKind.flat().flatMap((item) => proposeLinks(item, entities, contacts)),
    ...files.filter((file) => file.status === 'indexed').flatMap((file) => proposeFileLinks(file, entities)),
  ].filter(
    (proposal) => !known.has(linkKey(proposal.fromType, proposal.fromId, proposal.toEntityId, proposal.rel)),
  );
  return writeAutoLinks(store, proposals);
}

import type {
  ChunkNeighbor,
  ChunkText,
  Entity,
  Fact,
  FileEntry,
  Item,
  ItemKind,
  Link,
  LinkProposalRow,
} from '@regis/shared';
import type { BrainStore, EntityInput, FactInput } from './store';

export interface MemoryBrainStore extends BrainStore {
  entities: Entity[];
  links: Link[];
  items: Item[];
  files: FileEntry[];
  facts: Fact[];
  chunks: Map<string, ChunkText[]>;
  neighborsByFile: Map<string, ChunkNeighbor[]>;
  settings: Map<string, string>;
}

const NOW = '2026-03-01T10:00:00.000Z';

export function makeItem(overrides: Partial<Item> & Pick<Item, 'id' | 'kind'>): Item {
  return {
    connectorId: 'c-m365',
    externalId: overrides.id,
    title: 'Sujet',
    bodyText: null,
    occurredAt: NOW,
    dataJson: {},
    updatedAt: NOW,
    ...overrides,
  };
}

export function makeEntity(overrides: Partial<Entity> & Pick<Entity, 'id' | 'kind' | 'name'>): Entity {
  return { tagsJson: [], dataJson: {}, createdAt: NOW, updatedAt: NOW, ...overrides };
}

export function makeFile(overrides: Partial<FileEntry> & Pick<FileEntry, 'id'>): FileEntry {
  return {
    sourceId: 's1',
    relPath: `${overrides.id}.pdf`,
    ext: 'pdf',
    size: 1,
    mtime: NOW,
    sha256: null,
    role: 'reference',
    status: 'indexed',
    indexedAt: NOW,
    ...overrides,
  };
}

export function createMemoryBrainStore(
  seed: Partial<Pick<MemoryBrainStore, 'items' | 'files'>> = {},
): MemoryBrainStore {
  let counter = 0;
  const nextId = (prefix: string): string => {
    counter += 1;
    return `${prefix}${String(counter).padStart(3, '0')}`;
  };
  const store: MemoryBrainStore = {
    entities: [],
    links: [],
    items: seed.items ?? [],
    files: seed.files ?? [],
    facts: [],
    chunks: new Map(),
    neighborsByFile: new Map(),
    settings: new Map(),
    listEntities: () => Promise.resolve([...store.entities]),
    listLinks: () => Promise.resolve([...store.links]),
    listItems: (kind: ItemKind) => Promise.resolve(store.items.filter((item) => item.kind === kind)),
    listFiles: () => Promise.resolve([...store.files]),
    saveEntity: (input: EntityInput) => {
      const existing = input.id ? store.entities.find((entity) => entity.id === input.id) : undefined;
      const entity: Entity = {
        id: existing?.id ?? nextId('E'),
        kind: input.kind,
        name: input.name,
        tagsJson: input.tagsJson ?? [],
        dataJson: input.dataJson ?? {},
        createdAt: existing?.createdAt ?? NOW,
        updatedAt: NOW,
      };
      store.entities = existing
        ? store.entities.map((candidate) => (candidate.id === entity.id ? entity : candidate))
        : [...store.entities, entity];
      return Promise.resolve(entity);
    },
    insertAutoLinks: (rows: LinkProposalRow[]) => {
      let inserted = 0;
      for (const row of rows) {
        const duplicate = store.links.some(
          (link) =>
            link.fromType === row.fromType &&
            link.fromId === row.fromId &&
            link.toType === 'entity' &&
            link.toId === row.toEntityId &&
            link.rel === row.rel,
        );
        if (!duplicate) {
          store.links.push({
            id: nextId('L'),
            fromType: row.fromType,
            fromId: row.fromId,
            toType: 'entity',
            toId: row.toEntityId,
            rel: row.rel,
            origin: 'auto',
            confidence: row.confidence,
            createdAt: NOW,
          });
          inserted += 1;
        }
      }
      return Promise.resolve(inserted);
    },
    listFacts: (entityId) =>
      Promise.resolve(store.facts.filter((fact) => entityId === undefined || fact.entityId === entityId)),
    addFact: (input: FactInput) => {
      const fact: Fact = { id: nextId('F'), createdAt: NOW, ...input };
      store.facts.push(fact);
      return Promise.resolve(fact);
    },
    deleteFact: (id) => {
      store.facts = store.facts.filter((fact) => fact.id !== id);
      return Promise.resolve();
    },
    listChunks: (ownerType, ownerId) => Promise.resolve(store.chunks.get(`${ownerType}:${ownerId}`) ?? []),
    neighbors: (fileId) => Promise.resolve(store.neighborsByFile.get(fileId) ?? []),
    getSetting: (key) => Promise.resolve(store.settings.get(key) ?? null),
    setSetting: (key, value) => {
      store.settings.set(key, value);
      return Promise.resolve();
    },
    listSettings: (prefix) =>
      Promise.resolve(
        [...store.settings].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })),
      ),
  };
  return store;
}

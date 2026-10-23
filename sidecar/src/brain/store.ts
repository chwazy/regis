import type {
  ChunkNeighbor,
  ChunkText,
  Entity,
  EntityKind,
  Fact,
  FactStatus,
  FileEntry,
  Item,
  ItemKind,
  Link,
  LinkProposalRow,
} from '@regis/shared';

export interface EntityInput {
  id?: string;
  kind: EntityKind;
  name: string;
  tagsJson?: unknown;
  dataJson?: unknown;
}

export interface FactInput {
  entityId: string;
  text: string;
  sourceType: string;
  sourceId: string;
  status: FactStatus;
}

export interface SettingEntry {
  key: string;
  value: string;
}

export interface BrainStore {
  listEntities: () => Promise<Entity[]>;
  listLinks: () => Promise<Link[]>;
  listItems: (kind: ItemKind) => Promise<Item[]>;
  listFiles: () => Promise<FileEntry[]>;
  saveEntity: (input: EntityInput) => Promise<Entity>;
  insertAutoLinks: (links: LinkProposalRow[]) => Promise<number>;
  listFacts: (entityId?: string) => Promise<Fact[]>;
  addFact: (input: FactInput) => Promise<Fact>;
  deleteFact: (id: string) => Promise<void>;
  listChunks: (ownerType: string, ownerId: string) => Promise<ChunkText[]>;
  neighbors: (fileId: string) => Promise<ChunkNeighbor[]>;
  getSetting: (key: string) => Promise<string | null>;
  setSetting: (key: string, value: string) => Promise<void>;
  listSettings: (prefix: string) => Promise<SettingEntry[]>;
}

export type HostCall = <T>(method: string, params?: unknown) => Promise<T>;

export function createHostBrainStore(call: HostCall): BrainStore {
  return {
    listEntities: () => call<Entity[]>('store.entities.list', {}),
    listLinks: () => call<Link[]>('store.links.list', {}),
    listItems: (kind) => call<Item[]>('store.items.list', { kind }),
    listFiles: () => call<FileEntry[]>('store.files.list', {}),
    saveEntity: (input) => call<Entity>('store.entities.save', input),
    insertAutoLinks: async (links) => {
      if (links.length === 0) {
        return 0;
      }
      const result = await call<{ inserted: number }>('store.links.insertAuto', { links });
      return result.inserted;
    },
    listFacts: (entityId) => call<Fact[]>('store.facts.list', entityId === undefined ? {} : { entityId }),
    addFact: (input) => call<Fact>('store.facts.add', input),
    deleteFact: async (id) => {
      await call('store.facts.delete', { id });
    },
    listChunks: (ownerType, ownerId) => call<ChunkText[]>('store.chunks.list', { ownerType, ownerId }),
    neighbors: (fileId) => call<ChunkNeighbor[]>('store.chunks.neighbors', { fileId }),
    getSetting: async (key) => (await call<{ value: string | null }>('store.settings.get', { key })).value,
    setSetting: async (key, value) => {
      await call('store.settings.set', { key, value });
    },
    listSettings: (prefix) => call<SettingEntry[]>('store.settings.listPrefix', { prefix }),
  };
}

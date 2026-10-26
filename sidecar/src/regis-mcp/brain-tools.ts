import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Entity, EntityCard, Fact, GlobalSearchResult } from '@regis/shared';
import { normalizeFactText } from '../brain/entity-data';
import type { BrainStore } from '../brain/store';

export const REGIS_BRAIN_READ_TOOLS = ['mcp__regis__brain_search', 'mcp__regis__brain_get_entity'];
export const REGIS_BRAIN_ADD_FACT_TOOL = 'mcp__regis__brain_add_fact';
export const REGIS_BRAIN_WRITE_TOOLS = [
  'mcp__regis__brain_create_entity',
  'mcp__regis__brain_update_entity',
  'mcp__regis__brain_link_entities',
  REGIS_BRAIN_ADD_FACT_TOOL,
  'mcp__regis__brain_set_fact_status',
  'mcp__regis__brain_add_note',
  'mcp__regis__brain_add_resource',
  'mcp__regis__brain_remove_resource',
];

const RECENT_TIMELINE_LENGTH = 10;

const entityKind = z.enum(['client', 'project', 'contact', 'other']);
const tagList = z.array(z.string().trim().min(1)).max(20);

export const brainSearchInputShape = { query: z.string().trim().min(1) };
export const brainGetEntityInputShape = { entityId: z.string().min(1) };
export const brainAddFactInputShape = {
  entityId: z.string().min(1),
  text: z.string().trim().min(1),
};
export const brainCreateEntityInputShape = {
  kind: entityKind,
  name: z.string().trim().min(1),
  tags: tagList.optional(),
};
export const brainUpdateEntityInputShape = {
  entityId: z.string().min(1),
  name: z.string().trim().min(1).optional(),
  kind: entityKind.optional(),
  tags: tagList.optional(),
};
export const brainLinkEntitiesInputShape = {
  fromEntityId: z.string().min(1),
  toEntityId: z.string().min(1),
  rel: z.string().trim().min(1),
};
export const brainSetFactStatusInputShape = {
  factId: z.string().min(1),
  status: z.enum(['confirmed', 'to_verify', 'inferred', 'rejected']),
};
export const brainAddNoteInputShape = {
  entityId: z.string().min(1),
  text: z.string().trim().min(1),
};

const searchArguments = z.object(brainSearchInputShape);
const getEntityArguments = z.object(brainGetEntityInputShape);
const addFactArguments = z.object(brainAddFactInputShape);
const createEntityArguments = z.object(brainCreateEntityInputShape);
const updateEntityArguments = z.object(brainUpdateEntityInputShape);
const linkEntitiesArguments = z.object(brainLinkEntitiesInputShape);
const setFactStatusArguments = z.object(brainSetFactStatusInputShape);
export const brainAddResourceInputShape = {
  entityId: z.string().min(1),
  kind: z.enum(['repo', 'remote', 'conventions', 'specs', 'document', 'link']),
  value: z.string().trim().min(1),
  label: z.string().trim().min(1).optional(),
};
export const brainRemoveResourceInputShape = { resourceId: z.string().min(1) };

const addNoteArguments = z.object(brainAddNoteInputShape);
const addResourceArguments = z.object(brainAddResourceInputShape);
const removeResourceArguments = z.object(brainRemoveResourceInputShape);

export interface BrainToolContext {
  jobId: string;
  agentId: string;
}

export interface BrainToolsDeps {
  search: (query: string) => Promise<GlobalSearchResult>;
  getEntityCard: (entityId: string) => Promise<EntityCard>;
  store: Pick<
    BrainStore,
    | 'listEntities'
    | 'saveEntity'
    | 'updateEntity'
    | 'linkEntities'
    | 'listFacts'
    | 'addFact'
    | 'decideFact'
    | 'addNote'
    | 'addResource'
    | 'deleteResource'
  >;
  onNoteAdded?: () => void;
}

export interface BrainToolResult {
  isError: boolean;
  payload: unknown;
}

export interface BrainTools {
  search: (args: unknown) => Promise<BrainToolResult>;
  getEntity: (args: unknown) => Promise<BrainToolResult>;
  addFact: (context: BrainToolContext, args: unknown) => Promise<BrainToolResult>;
  createEntity: (args: unknown) => Promise<BrainToolResult>;
  updateEntity: (args: unknown) => Promise<BrainToolResult>;
  linkEntities: (args: unknown) => Promise<BrainToolResult>;
  setFactStatus: (args: unknown) => Promise<BrainToolResult>;
  addNote: (args: unknown) => Promise<BrainToolResult>;
  addResource: (args: unknown) => Promise<BrainToolResult>;
  removeResource: (args: unknown) => Promise<BrainToolResult>;
}

const refuse = (message: string): BrainToolResult => ({ isError: true, payload: { error: message } });
const succeed = (payload: unknown): BrainToolResult => ({ isError: false, payload });
const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const sameName = (left: string, right: string): boolean =>
  left.trim().localeCompare(right.trim(), 'fr', { sensitivity: 'base' }) === 0;
const entitySummary = (entity: Entity) => ({ id: entity.id, kind: entity.kind, name: entity.name });

export function createBrainTools(deps: BrainToolsDeps): BrainTools {
  return {
    async search(args) {
      const parsed = searchArguments.safeParse(args);
      if (!parsed.success) {
        return refuse(`Paramètres invalides : ${parsed.error.message}`);
      }
      const result = await deps.search(parsed.data.query);
      return succeed({
        entities: result.entities.map((entity) => ({ id: entity.id, kind: entity.kind, name: entity.name })),
        documents: result.documents,
        mails: result.mails,
      });
    },
    async getEntity(args) {
      const parsed = getEntityArguments.safeParse(args);
      if (!parsed.success) {
        return refuse(`Paramètres invalides : ${parsed.error.message}`);
      }
      const card = await deps.getEntityCard(parsed.data.entityId).catch(() => undefined);
      if (!card) {
        return refuse(`Entité introuvable : ${parsed.data.entityId}`);
      }
      return succeed({
        entity: { id: card.entity.id, kind: card.entity.kind, name: card.entity.name },
        facts: card.facts.map((view) => ({
          id: view.fact.id,
          text: view.fact.text,
          status: view.fact.status,
          source: view.source.label,
        })),
        resources: card.resources.map((resource) => ({
          id: resource.id,
          kind: resource.kind,
          label: resource.label,
          value: resource.value,
        })),
        projects: card.projects.map((project) => ({
          id: project.entity.id,
          name: project.entity.name,
          hoursLogged: project.hoursLogged,
        })),
        links: card.links.map((link) => ({
          rel: link.rel,
          direction: link.direction,
          id: link.entity.id,
          name: link.entity.name,
        })),
        documents: card.documents.map((document) => ({ fileId: document.fileId, name: document.name })),
        recentActivity: card.timeline.slice(0, RECENT_TIMELINE_LENGTH),
      });
    },
    async addFact(context, args) {
      const parsed = addFactArguments.safeParse(args);
      if (!parsed.success) {
        return refuse(`Paramètres invalides : ${parsed.error.message}`);
      }
      if (context.jobId === '') {
        return refuse('Job appelant inconnu');
      }
      const known = await deps.getEntityCard(parsed.data.entityId).catch(() => undefined);
      if (!known) {
        return refuse(`Entité introuvable : ${parsed.data.entityId}`);
      }
      const existing = await deps.store.listFacts(parsed.data.entityId);
      const duplicate = existing.find(
        (fact: Fact) => normalizeFactText(fact.text) === normalizeFactText(parsed.data.text),
      );
      if (duplicate) {
        return succeed({ factId: duplicate.id, status: duplicate.status, duplicate: true });
      }
      const fact = await deps.store.addFact({
        entityId: parsed.data.entityId,
        text: parsed.data.text,
        sourceType: 'job',
        sourceId: context.jobId,
        status: 'inferred',
      });
      return succeed({ factId: fact.id, status: fact.status, duplicate: false });
    },
    async createEntity(args) {
      const parsed = createEntityArguments.safeParse(args);
      if (!parsed.success) {
        return refuse(`Paramètres invalides : ${parsed.error.message}`);
      }
      const { kind, name, tags } = parsed.data;
      const existing = (await deps.store.listEntities()).find(
        (entity) => entity.kind === kind && sameName(entity.name, name),
      );
      if (existing) {
        return succeed({ entity: entitySummary(existing), duplicate: true });
      }
      try {
        const entity = await deps.store.saveEntity({ kind, name, ...(tags ? { tagsJson: tags } : {}) });
        return succeed({ entity: entitySummary(entity), duplicate: false });
      } catch (error) {
        return refuse(`Création impossible : ${reasonOf(error)}`);
      }
    },
    async updateEntity(args) {
      const parsed = updateEntityArguments.safeParse(args);
      if (!parsed.success) {
        return refuse(`Paramètres invalides : ${parsed.error.message}`);
      }
      const { entityId, name, kind, tags } = parsed.data;
      if (name === undefined && kind === undefined && tags === undefined) {
        return refuse('Rien à modifier : fournis name, kind ou tags');
      }
      try {
        const entity = await deps.store.updateEntity({
          id: entityId,
          ...(name === undefined ? {} : { name }),
          ...(kind === undefined ? {} : { kind }),
          ...(tags === undefined ? {} : { tags }),
        });
        return succeed({ entity: { ...entitySummary(entity), tags: entity.tagsJson } });
      } catch (error) {
        return refuse(`Modification impossible : ${reasonOf(error)}`);
      }
    },
    async linkEntities(args) {
      const parsed = linkEntitiesArguments.safeParse(args);
      if (!parsed.success) {
        return refuse(`Paramètres invalides : ${parsed.error.message}`);
      }
      try {
        const inserted = await deps.store.linkEntities(parsed.data);
        return succeed({ linked: true, duplicate: inserted === 0 });
      } catch (error) {
        return refuse(`Lien impossible : ${reasonOf(error)}`);
      }
    },
    async setFactStatus(args) {
      const parsed = setFactStatusArguments.safeParse(args);
      if (!parsed.success) {
        return refuse(`Paramètres invalides : ${parsed.error.message}`);
      }
      try {
        const fact = await deps.store.decideFact(parsed.data.factId, parsed.data.status);
        return succeed(
          fact === null
            ? { factId: parsed.data.factId, deleted: true }
            : { factId: fact.id, status: fact.status },
        );
      } catch (error) {
        return refuse(`Mise à jour impossible : ${reasonOf(error)}`);
      }
    },
    async addNote(args) {
      const parsed = addNoteArguments.safeParse(args);
      if (!parsed.success) {
        return refuse(`Paramètres invalides : ${parsed.error.message}`);
      }
      try {
        const note = await deps.store.addNote(parsed.data.entityId, parsed.data.text);
        deps.onNoteAdded?.();
        return succeed({ noteId: note.id, title: note.title });
      } catch (error) {
        return refuse(`Note impossible : ${reasonOf(error)}`);
      }
    },
    async addResource(args) {
      const parsed = addResourceArguments.safeParse(args);
      if (!parsed.success) {
        return refuse(`Paramètres invalides : ${parsed.error.message}`);
      }
      try {
        const resource = await deps.store.addResource(parsed.data);
        return succeed({ resourceId: resource.id, kind: resource.kind, value: resource.value });
      } catch (error) {
        return refuse(`Ressource impossible : ${reasonOf(error)}`);
      }
    },
    async removeResource(args) {
      const parsed = removeResourceArguments.safeParse(args);
      if (!parsed.success) {
        return refuse(`Paramètres invalides : ${parsed.error.message}`);
      }
      const deleted = await deps.store.deleteResource(parsed.data.resourceId);
      return deleted
        ? succeed({ resourceId: parsed.data.resourceId, deleted: true })
        : refuse(`Ressource introuvable : ${parsed.data.resourceId}`);
    },
  };
}

export function registerBrainTools(mcp: McpServer, context: BrainToolContext, tools: BrainTools): void {
  const asContent = (result: BrainToolResult) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(result.payload) }],
    ...(result.isError ? { isError: true } : {}),
  });
  mcp.registerTool(
    'brain_search',
    {
      description: 'Searches the second brain: entities by name prefix, then documents and mails by content.',
      inputSchema: brainSearchInputShape,
    },
    async (args) => asContent(await tools.search(args)),
  );
  mcp.registerTool(
    'brain_get_entity',
    {
      description:
        'Returns the card of an entity: sourced facts with status, resources (repos, remotes, conventions, specs…), projects, links, documents and recent activity.',
      inputSchema: brainGetEntityInputShape,
    },
    async (args) => asContent(await tools.getEntity(args)),
  );
  mcp.registerTool(
    'brain_add_fact',
    {
      description:
        'Records a fact about an entity. It is stored as inferred and sourced to the calling job; the user confirms it later.',
      inputSchema: brainAddFactInputShape,
    },
    async (args) => asContent(await tools.addFact(context, args)),
  );
  mcp.registerTool(
    'brain_create_entity',
    {
      description:
        'Creates an entity (client, project, contact or other) in the second brain. Returns the existing one when an entity of the same kind and name already exists.',
      inputSchema: brainCreateEntityInputShape,
    },
    async (args) => asContent(await tools.createEntity(args)),
  );
  mcp.registerTool(
    'brain_update_entity',
    {
      description: 'Renames an entity, changes its kind or replaces its tags.',
      inputSchema: brainUpdateEntityInputShape,
    },
    async (args) => asContent(await tools.updateEntity(args)),
  );
  mcp.registerTool(
    'brain_link_entities',
    {
      description:
        'Links two entities. Use rel "belongs_to" for a project or contact that belongs to a client, or another short relation such as "works_with".',
      inputSchema: brainLinkEntitiesInputShape,
    },
    async (args) => asContent(await tools.linkEntities(args)),
  );
  mcp.registerTool(
    'brain_set_fact_status',
    {
      description:
        'Changes the status of a fact to confirmed, to_verify or inferred; "rejected" deletes the fact.',
      inputSchema: brainSetFactStatusInputShape,
    },
    async (args) => asContent(await tools.setFactStatus(args)),
  );
  mcp.registerTool(
    'brain_add_note',
    {
      description: 'Adds a free-form note to an entity, for context that does not fit in a single fact.',
      inputSchema: brainAddNoteInputShape,
    },
    async (args) => asContent(await tools.addNote(args)),
  );
  mcp.registerTool(
    'brain_add_resource',
    {
      description:
        'Attaches a resource to an entity, usually a project: a local repo path, a git remote, a conventions file, a specs folder, a document or a link.',
      inputSchema: brainAddResourceInputShape,
    },
    async (args) => asContent(await tools.addResource(args)),
  );
  mcp.registerTool(
    'brain_remove_resource',
    {
      description: 'Removes a resource from its entity, by the id returned by brain_get_entity.',
      inputSchema: brainRemoveResourceInputShape,
    },
    async (args) => asContent(await tools.removeResource(args)),
  );
}

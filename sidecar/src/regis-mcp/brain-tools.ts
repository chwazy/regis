import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { EntityCard, Fact, GlobalSearchResult } from '@regis/shared';
import { normalizeFactText } from '../brain/entity-data';
import type { BrainStore } from '../brain/store';

export const REGIS_BRAIN_READ_TOOLS = ['mcp__regis__brain_search', 'mcp__regis__brain_get_entity'];
export const REGIS_BRAIN_ADD_FACT_TOOL = 'mcp__regis__brain_add_fact';

const RECENT_TIMELINE_LENGTH = 10;

export const brainSearchInputShape = { query: z.string().trim().min(1) };
export const brainGetEntityInputShape = { entityId: z.string().min(1) };
export const brainAddFactInputShape = {
  entityId: z.string().min(1),
  text: z.string().trim().min(1),
};

const searchArguments = z.object(brainSearchInputShape);
const getEntityArguments = z.object(brainGetEntityInputShape);
const addFactArguments = z.object(brainAddFactInputShape);

export interface BrainToolContext {
  jobId: string;
  agentId: string;
}

export interface BrainToolsDeps {
  search: (query: string) => Promise<GlobalSearchResult>;
  getEntityCard: (entityId: string) => Promise<EntityCard>;
  store: Pick<BrainStore, 'listFacts' | 'addFact'>;
}

export interface BrainToolResult {
  isError: boolean;
  payload: unknown;
}

export interface BrainTools {
  search: (args: unknown) => Promise<BrainToolResult>;
  getEntity: (args: unknown) => Promise<BrainToolResult>;
  addFact: (context: BrainToolContext, args: unknown) => Promise<BrainToolResult>;
}

const refuse = (message: string): BrainToolResult => ({ isError: true, payload: { error: message } });
const succeed = (payload: unknown): BrainToolResult => ({ isError: false, payload });

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
        'Returns the card of an entity: sourced facts with status, projects, links, documents and recent activity.',
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
}

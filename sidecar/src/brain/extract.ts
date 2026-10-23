import { z } from 'zod';
import type { Agent, Entity, Fact, Item, Job, RoutingRule } from '@regis/shared';
import type { StartJobInput } from '../jobs/runner';
import { parseConditions, route, type RoutingContext, type RoutingDecision } from '../routing/engine';
import { normalizeFactText, normalizeText } from './entity-data';
import type { BrainStore } from './store';

export interface ExtractedFact {
  entityName: string;
  text: string;
  status: 'inferred' | 'to_verify';
}

export interface ExtractionSource {
  type: 'item' | 'chunk';
  id: string;
  text: string;
}

export class ExtractionFormatError extends Error {}
export class ExtractionJobError extends Error {}

export interface ExtractionDeps {
  runner: {
    start: (input: StartJobInput) => Promise<Job>;
    waitForEnd: (jobId: string) => Promise<Job>;
  };
  pickAgent: (task: string) => Promise<{ agentId: string; reason: string }>;
  store: Pick<BrainStore, 'listFacts' | 'addFact' | 'insertAutoLinks'>;
  failJob: (jobId: string, error: string) => Promise<void>;
}

export const MAX_SOURCE_CHARS = 6000;

const TRANSCRIPT_NOTE_TYPE = 'transcript';

/** Les transcripts de réunion ne passent pas par l'extraction de faits. */
export function isExtractableItem(item: Pick<Item, 'dataJson'>): boolean {
  const data: unknown = item.dataJson;
  return !(
    typeof data === 'object' &&
    data !== null &&
    (data as { noteType?: unknown }).noteType === TRANSCRIPT_NOTE_TYPE
  );
}
export const MAX_FACTS_PER_SOURCE = 10;

const extractedFacts = z.array(
  z.object({
    entityName: z.string().trim().min(1),
    text: z.string().trim().min(1),
    status: z.enum(['inferred', 'to_verify']),
  }),
);

const wrappedFacts = z.object({ facts: extractedFacts });

export function validateExtraction(raw: unknown): ExtractedFact[] {
  const parsed = Array.isArray(raw) ? extractedFacts.safeParse(raw) : wrappedFacts.safeParse(raw);
  if (!parsed.success) {
    throw new ExtractionFormatError(`Sortie d’extraction invalide : ${parsed.error.message}`);
  }
  return Array.isArray(parsed.data) ? parsed.data : parsed.data.facts;
}

export function parseExtractionText(text: string): ExtractedFact[] {
  const starts = [text.indexOf('['), text.indexOf('{')].filter((index) => index >= 0);
  const start = starts.length === 0 ? -1 : Math.min(...starts);
  const end = Math.max(text.lastIndexOf(']'), text.lastIndexOf('}'));
  if (start < 0 || end <= start) {
    throw new ExtractionFormatError('Aucun JSON dans la réponse d’extraction');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new ExtractionFormatError('JSON illisible dans la réponse d’extraction');
  }
  return validateExtraction(raw);
}

export function buildExtractionPrompt(source: ExtractionSource, candidates: Entity[]): string {
  const names = candidates.map((entity) => `- ${entity.name} (${entity.kind})`).join('\n');
  const body = source.text.length > MAX_SOURCE_CHARS ? source.text.slice(0, MAX_SOURCE_CHARS) : source.text;
  return [
    'Extract durable facts about the listed entities from the text below.',
    'Reply with JSON only, no prose: an array of {"entityName": string, "text": string, "status": "inferred" | "to_verify"}.',
    'entityName must be copied exactly from the list. Write each text in French, as one short sentence.',
    'Use "to_verify" when the text only suggests the fact or is ambiguous, otherwise "inferred".',
    'Only report facts stated in the text. Do not compute or guess any figure. Reply [] when there is nothing to report.',
    '',
    'Entities:',
    names,
    '',
    'Text:',
    body,
  ].join('\n');
}

function isExplicitExtractionRule(rule: RoutingRule): boolean {
  const conditions = parseConditions(rule.conditionsJson);
  return conditions.taskType === 'extraction' || conditions.requireLocal === true;
}

export function pickExtractionAgent(
  ctx: RoutingContext,
  rules: RoutingRule[],
  agents: Agent[],
): RoutingDecision | null {
  const byRule = route(ctx, rules.filter(isExplicitExtractionRule), agents);
  if (byRule) {
    return byRule;
  }
  const local = agents.filter((agent) => agent.enabled && agent.isLocalOnly);
  const chosen = local.find((agent) => agent.runtime === 'ollama') ?? local[0];
  return chosen
    ? { agentId: chosen.id, ruleId: null, reason: 'Extraction : agent local par défaut', viaFallback: false }
    : null;
}

let activeDeps: ExtractionDeps | undefined;

export function configureExtraction(deps: ExtractionDeps): void {
  activeDeps = deps;
}

export async function extractFacts(
  source: ExtractionSource,
  candidates: Entity[],
  deps: ExtractionDeps | undefined = activeDeps,
): Promise<Fact[]> {
  if (!deps) {
    throw new ExtractionJobError('L’extraction n’est pas configurée');
  }
  const prompt = buildExtractionPrompt(source, candidates);
  const agent = await deps.pickAgent(prompt);
  const job = await deps.runner.start({
    agentId: agent.agentId,
    title: `Extraction de faits (${source.type === 'item' ? 'mail' : 'fichier'})`,
    prompt,
    kind: 'extract',
    routingReason: agent.reason,
    contextRefs: [{ type: source.type, id: source.id }],
  });
  await deps.store.insertAutoLinks(
    candidates.map((entity) => ({
      fromType: 'job',
      fromId: job.id,
      toEntityId: entity.id,
      rel: 'about',
      confidence: 1,
    })),
  );
  const finished = await deps.runner.waitForEnd(job.id);
  if (finished.status !== 'done' || finished.resultText === null) {
    throw new ExtractionJobError(finished.error ?? `Le job d’extraction ${job.id} a échoué`);
  }
  let extracted: ExtractedFact[];
  try {
    extracted = parseExtractionText(finished.resultText);
  } catch (error) {
    await deps.failJob(job.id, error instanceof Error ? error.message : String(error));
    throw error;
  }
  return insertNewFacts(source, candidates, extracted.slice(0, MAX_FACTS_PER_SOURCE), deps.store);
}

async function insertNewFacts(
  source: ExtractionSource,
  candidates: Entity[],
  extracted: ExtractedFact[],
  store: Pick<BrainStore, 'listFacts' | 'addFact'>,
): Promise<Fact[]> {
  const byName = new Map(candidates.map((entity) => [normalizeText(entity.name), entity]));
  const knownTexts = new Map<string, Set<string>>();
  const created: Fact[] = [];
  for (const candidate of extracted) {
    const entity = byName.get(normalizeText(candidate.entityName));
    if (!entity) {
      continue;
    }
    if (!knownTexts.has(entity.id)) {
      const facts = await store.listFacts(entity.id);
      knownTexts.set(entity.id, new Set(facts.map((fact) => normalizeFactText(fact.text))));
    }
    const texts = knownTexts.get(entity.id);
    const normalized = normalizeFactText(candidate.text);
    if (!texts || texts.has(normalized)) {
      continue;
    }
    texts.add(normalized);
    created.push(
      await store.addFact({
        entityId: entity.id,
        text: candidate.text,
        sourceType: source.type,
        sourceId: source.id,
        status: candidate.status,
      }),
    );
  }
  return created;
}

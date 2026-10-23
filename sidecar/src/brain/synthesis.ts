import { createHash } from 'node:crypto';
import type { Entity, EntityCard, EntitySynthesis, Job, LinkProposalRow } from '@regis/shared';
import type { StartJobInput } from '../jobs/runner';
import type { HostCall } from './store';

export const SYNTHESES_PER_RUN = 3;
export const MIN_REFRESH_MS = 6 * 60 * 60_000;
export const MAX_SYNTHESIS_CHARS = 1200;
const MAX_PROMPT_FACTS = 30;
const MAX_PROMPT_TIMELINE = 20;
const MAX_PROMPT_NOTES = 10;

export class SynthesisFormatError extends Error {}
export class SynthesisJobError extends Error {}

export interface SynthesisSaveInput {
  entityId: string;
  text: string;
  sourceCount: number;
  signature: string;
  jobId: string | null;
}

export interface SynthesisStore {
  listEntities: () => Promise<Entity[]>;
  entityCard: (entityId: string) => Promise<EntityCard>;
  listSyntheses: () => Promise<EntitySynthesis[]>;
  saveSynthesis: (input: SynthesisSaveInput) => Promise<EntitySynthesis>;
  insertAutoLinks: (links: LinkProposalRow[]) => Promise<number>;
}

export interface SynthesisDeps {
  store: SynthesisStore;
  runner: {
    start: (input: StartJobInput) => Promise<Job>;
    waitForEnd: (jobId: string) => Promise<Job>;
  };
  pickAgent: (task: string) => Promise<{ agentId: string; reason: string }>;
  failJob: (jobId: string, error: string) => Promise<void>;
  now?: () => Date;
}

export interface SynthesisReport {
  generated: number;
  failed: number;
  pending: number;
}

export function createHostSynthesisStore(call: HostCall): SynthesisStore {
  return {
    listEntities: () => call<Entity[]>('store.entities.list', {}),
    entityCard: (entityId) => call<EntityCard>('store.brain.entityCard', { id: entityId }),
    listSyntheses: () => call<EntitySynthesis[]>('store.syntheses.list', {}),
    saveSynthesis: (input) => call<EntitySynthesis>('store.syntheses.save', input),
    insertAutoLinks: async (links) => {
      if (links.length === 0) {
        return 0;
      }
      return (await call<{ inserted: number }>('store.links.insertAuto', { links })).inserted;
    },
  };
}

export function synthesisSourceCount(card: EntityCard): number {
  return card.facts.length + card.timeline.length + card.notes.length;
}

export function synthesisSignature(card: EntityCard): string {
  const parts = [
    card.entity.name,
    card.entity.kind,
    ...card.facts.map((view) => `f:${view.fact.id}:${view.fact.status}`).sort(),
    ...card.timeline.map((entry) => `t:${entry.id}`).sort(),
    ...card.notes.map((note) => `n:${note.id}`).sort(),
    ...card.projects.map((project) => `p:${project.entity.id}`).sort(),
  ];
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 32);
}

export function needsSynthesis(
  card: EntityCard,
  existing: EntitySynthesis | undefined,
  now: Date,
  force = false,
): boolean {
  if (synthesisSourceCount(card) === 0) {
    return false;
  }
  if (!existing || force) {
    return true;
  }
  if (existing.signature === synthesisSignature(card)) {
    return false;
  }
  return now.getTime() - Date.parse(existing.generatedAt) >= MIN_REFRESH_MS;
}

function withoutHoursPrefix(kind: string, text: string): string {
  return kind === 'time_entry' ? text.replace(/^[^·]*·\s*/, '') : text;
}

export function buildSynthesisPrompt(card: EntityCard): string {
  const { entity } = card;
  const tags = Array.isArray(entity.tagsJson) ? entity.tagsJson.filter((tag) => typeof tag === 'string') : [];
  const lines = (values: string[]) =>
    values.length === 0 ? ['- (aucun)'] : values.map((value) => `- ${value}`);
  return [
    'Write a short synthesis in French, 3 to 5 sentences, of the overall context of the entity below:',
    'who it is, the ongoing topics, and what is expected next.',
    'Use only the information given. Do not write any figure: no amounts, hours, durations, counts,',
    'percentages or dates. Reply with the synthesis text only, without title, list or quotes.',
    '',
    `Entity: ${entity.name} (${entity.kind})${tags.length > 0 ? ` · tags: ${tags.join(', ')}` : ''}`,
    '',
    'Projects:',
    ...lines(card.projects.map((project) => project.entity.name)),
    '',
    'Facts:',
    ...lines(card.facts.slice(0, MAX_PROMPT_FACTS).map((view) => view.fact.text)),
    '',
    'Recent activity:',
    ...lines(
      card.timeline
        .slice(0, MAX_PROMPT_TIMELINE)
        .map((entry) => `${entry.kind}: ${withoutHoursPrefix(entry.kind, entry.text)}`),
    ),
    '',
    'Notes:',
    ...lines(card.notes.slice(0, MAX_PROMPT_NOTES).map((note) => note.text.replace(/\s+/g, ' '))),
  ].join('\n');
}

export function namedNumbers(card: EntityCard): string[] {
  const sources = [
    card.entity.name,
    ...card.projects.map((project) => project.entity.name),
    ...card.links.map((link) => link.entity.name),
    ...card.timeline.map((entry) => withoutHoursPrefix(entry.kind, entry.text)),
  ];
  const phrases = new Set<string>();
  for (const source of sources) {
    for (const match of source.matchAll(/\p{L}+\s+\d+(?:[.,]\d+)*/gu)) {
      phrases.add(match[0].toLowerCase());
    }
  }
  return [...phrases].sort((left, right) => right.length - left.length);
}

export function stripFigures(text: string, allowed: string[] = []): string {
  const sentences = text.split(/(?<=[.!?])\s+/);
  return sentences
    .filter((sentence) => {
      let rest = sentence.toLowerCase();
      for (const phrase of allowed) {
        rest = rest.split(phrase).join(' ');
      }
      return !/\d/.test(rest);
    })
    .join(' ')
    .trim();
}

export function parseSynthesisText(raw: string, allowed: string[] = []): string {
  const unwrapped = raw
    .trim()
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/\s*```$/, '')
    .replace(/^["«“]\s*|\s*["»”]$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  let text = stripFigures(unwrapped, allowed);
  if (text.length > MAX_SYNTHESIS_CHARS) {
    const cut = text.slice(0, MAX_SYNTHESIS_CHARS);
    const end = cut.lastIndexOf('. ');
    text = end > 0 ? cut.slice(0, end + 1) : cut;
  }
  if (text === '') {
    throw new SynthesisFormatError('Synthèse vide ou sans phrase utilisable');
  }
  return text;
}

export async function synthesizeEntity(card: EntityCard, deps: SynthesisDeps): Promise<EntitySynthesis> {
  const prompt = buildSynthesisPrompt(card);
  const signature = synthesisSignature(card);
  const agent = await deps.pickAgent(prompt);
  const job = await deps.runner.start({
    agentId: agent.agentId,
    title: `Synthèse — ${card.entity.name}`,
    prompt,
    kind: 'synthesis',
    routingReason: agent.reason,
    contextRefs: [{ type: 'entity', id: card.entity.id }],
  });
  await deps.store.insertAutoLinks([
    { fromType: 'job', fromId: job.id, toEntityId: card.entity.id, rel: 'about', confidence: 1 },
  ]);
  const finished = await deps.runner.waitForEnd(job.id);
  if (finished.status !== 'done' || finished.resultText === null) {
    throw new SynthesisJobError(finished.error ?? `Le job de synthèse ${job.id} a échoué`);
  }
  let text: string;
  try {
    text = parseSynthesisText(finished.resultText, namedNumbers(card));
  } catch (error) {
    await deps.failJob(job.id, error instanceof Error ? error.message : String(error));
    throw error;
  }
  return deps.store.saveSynthesis({
    entityId: card.entity.id,
    text,
    sourceCount: synthesisSourceCount(card),
    signature,
    jobId: job.id,
  });
}

export class SynthesisService {
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: SynthesisDeps) {}

  isRunning(entityId: string): boolean {
    return this.inFlight.has(entityId);
  }

  async refresh(entityId: string): Promise<EntitySynthesis | null> {
    return this.runOne(entityId, true);
  }

  async runPending(limit = SYNTHESES_PER_RUN): Promise<SynthesisReport> {
    const [entities, syntheses] = await Promise.all([
      this.deps.store.listEntities(),
      this.deps.store.listSyntheses(),
    ]);
    const existing = new Map(syntheses.map((synthesis) => [synthesis.entityId, synthesis]));
    const now = this.now();
    const report: SynthesisReport = { generated: 0, failed: 0, pending: 0 };
    const due: EntityCard[] = [];
    for (const entity of entities) {
      if (this.inFlight.has(entity.id)) {
        continue;
      }
      const card = await this.deps.store.entityCard(entity.id);
      if (needsSynthesis(card, existing.get(entity.id), now)) {
        due.push(card);
      }
    }
    report.pending = due.length;
    for (const card of due.slice(0, limit)) {
      const outcome = await this.generate(card);
      if (outcome === 'interrupted') {
        break;
      }
      report[outcome] += 1;
      report.pending -= 1;
    }
    return report;
  }

  private async runOne(entityId: string, force: boolean): Promise<EntitySynthesis | null> {
    if (this.inFlight.has(entityId)) {
      return null;
    }
    const card = await this.deps.store.entityCard(entityId);
    const existing = (await this.deps.store.listSyntheses()).find(
      (synthesis) => synthesis.entityId === entityId,
    );
    if (!needsSynthesis(card, existing, this.now(), force)) {
      return existing ?? null;
    }
    this.inFlight.add(entityId);
    try {
      return await synthesizeEntity(card, this.deps);
    } finally {
      this.inFlight.delete(entityId);
    }
  }

  private async generate(card: EntityCard): Promise<'generated' | 'failed' | 'interrupted'> {
    this.inFlight.add(card.entity.id);
    try {
      await synthesizeEntity(card, this.deps);
      return 'generated';
    } catch (error) {
      return error instanceof SynthesisFormatError ? 'failed' : 'interrupted';
    } finally {
      this.inFlight.delete(card.entity.id);
    }
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }
}

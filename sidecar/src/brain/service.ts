import type { Entity, Fact, Item, Link } from '@regis/shared';
import { DEFAULT_TIMEZONE } from '../routing/engine';
import { TIMEZONE_SETTING, calendarDay } from '../routing/context';
import { runAutolink } from './autolink';
import { bootstrapFromOdoo } from './bootstrap';
import { ExtractionFormatError, isExtractableItem, type ExtractionSource } from './extract';
import type { BrainStore } from './store';
import type { SynthesisReport } from './synthesis';

export const MAX_EXTRACTIONS_SETTING = 'brain.maxExtractionsPerDay';
export const DEFAULT_MAX_EXTRACTIONS_PER_DAY = 200;
export const EXTRACTION_BATCH_SIZE = 3;
export const MAX_CHUNKS_PER_FILE = 5;
export const RUN_INTERVAL_MS = 15 * 60_000;
export const RUN_DEBOUNCE_MS = 5_000;

const LEDGER_PREFIX = 'brain.extracted.';
const DAY_COUNTER_KEY = 'brain.extractionDay';

export interface PendingSource {
  ledgerKey: string;
  source: ExtractionSource;
  candidates: Entity[];
  at: string;
}

export interface ExtractionReport {
  processed: number;
  failed: number;
  pending: number;
}

export interface BrainRunReport {
  entitiesCreated: number;
  linksCreated: number;
  extraction: ExtractionReport;
  synthesis: SynthesisReport;
}

export interface BrainServiceDeps {
  store: BrainStore;
  extract: (source: ExtractionSource, candidates: Entity[]) => Promise<Fact[]>;
  synthesize?: () => Promise<SynthesisReport>;
  now?: () => Date;
  onLog: (line: string) => void;
}

function linkEndpointKey(type: string, id: string): string {
  return `${type}:${id}`;
}

function textOf(item: Item): string {
  return [item.title, item.bodyText ?? ''].filter((part) => part.trim() !== '').join('\n');
}

export async function listPendingSources(store: BrainStore): Promise<PendingSource[]> {
  const [entities, links, files, messages, notes, ledgerEntries] = await Promise.all([
    store.listEntities(),
    store.listLinks(),
    store.listFiles(),
    store.listItems('message'),
    store.listItems('note'),
    store.listSettings(LEDGER_PREFIX),
  ]);
  const ledger = new Set(ledgerEntries.map((entry) => entry.key.slice(LEDGER_PREFIX.length)));
  const entityById = new Map(entities.map((entity) => [entity.id, entity]));
  const candidatesOf = (type: string, id: string, linkList: Link[]): Entity[] => {
    const seen = new Set<string>();
    return linkList
      .filter((link) => link.fromType === type && link.fromId === id && link.toType === 'entity')
      .flatMap((link) => {
        const entity = entityById.get(link.toId);
        if (!entity || seen.has(entity.id)) {
          return [];
        }
        seen.add(entity.id);
        return [entity];
      });
  };
  const linkedFrom = new Set(
    links
      .filter((link) => link.toType === 'entity')
      .map((link) => linkEndpointKey(link.fromType, link.fromId)),
  );
  const pending: PendingSource[] = [];
  for (const item of [...messages, ...notes]) {
    if (
      !isExtractableItem(item) ||
      ledger.has(`item.${item.id}`) ||
      !linkedFrom.has(linkEndpointKey('item', item.id))
    ) {
      continue;
    }
    const text = textOf(item);
    if (text.trim() === '') {
      continue;
    }
    pending.push({
      ledgerKey: `item.${item.id}`,
      source: { type: 'item', id: item.id, text },
      candidates: candidatesOf('item', item.id, links),
      at: item.occurredAt ?? item.updatedAt,
    });
  }
  for (const file of files) {
    if (
      file.status !== 'indexed' ||
      ledger.has(`file.${file.id}`) ||
      !linkedFrom.has(linkEndpointKey('file', file.id))
    ) {
      continue;
    }
    const chunks = (await store.listChunks('file', file.id)).slice(0, MAX_CHUNKS_PER_FILE);
    const open = chunks.filter((chunk) => !ledger.has(`chunk.${String(chunk.id)}`));
    if (open.length === 0) {
      await store.setSetting(`${LEDGER_PREFIX}file.${file.id}`, 'done');
      continue;
    }
    const candidates = candidatesOf('file', file.id, links);
    for (const chunk of open) {
      pending.push({
        ledgerKey: `chunk.${String(chunk.id)}`,
        source: { type: 'chunk', id: String(chunk.id), text: chunk.text },
        candidates,
        at: file.mtime,
      });
    }
  }
  return pending.sort((left, right) => right.at.localeCompare(left.at));
}

export class BrainService {
  private running: Promise<BrainRunReport> | undefined;
  private debounce: NodeJS.Timeout | undefined;
  private interval: NodeJS.Timeout | undefined;

  constructor(private readonly deps: BrainServiceDeps) {}

  start(): void {
    this.requestRun();
    this.interval ??= setInterval(() => this.requestRun(), RUN_INTERVAL_MS);
    this.interval.unref();
  }

  stop(): void {
    if (this.debounce) {
      clearTimeout(this.debounce);
      this.debounce = undefined;
    }
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
  }

  requestRun(delayMs: number = RUN_DEBOUNCE_MS): void {
    if (this.debounce) {
      clearTimeout(this.debounce);
    }
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      this.run().catch((error: unknown) => {
        this.deps.onLog(`[brain] cycle en échec : ${errorMessage(error)}`);
      });
    }, delayMs);
    this.debounce.unref();
  }

  run(): Promise<BrainRunReport> {
    this.running ??= this.execute().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async execute(): Promise<BrainRunReport> {
    const report: BrainRunReport = {
      entitiesCreated: 0,
      linksCreated: 0,
      extraction: { processed: 0, failed: 0, pending: 0 },
      synthesis: { generated: 0, failed: 0, pending: 0 },
    };
    await this.step('bootstrap', async () => {
      const result = await bootstrapFromOdoo(this.deps.store);
      report.entitiesCreated = result.clients + result.projects + result.contacts;
      report.linksCreated += result.links;
    });
    await this.step('rattachement', async () => {
      report.linksCreated += await runAutolink(this.deps.store);
    });
    await this.step('extraction', async () => {
      report.extraction = await this.extractPending();
    });
    const { synthesize } = this.deps;
    if (synthesize) {
      await this.step('synthèse', async () => {
        report.synthesis = await synthesize();
      });
    }
    return report;
  }

  private async step(name: string, action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      this.deps.onLog(`[brain] ${name} en échec : ${errorMessage(error)}`);
    }
  }

  async extractPending(): Promise<ExtractionReport> {
    const { store } = this.deps;
    const pending = await listPendingSources(store);
    const today = calendarDay(this.now(), await this.timezone());
    const limit = await this.readLimit();
    let count = await this.readCount(today);
    const queue = pending.slice(0, Math.max(0, limit - count));
    const report: ExtractionReport = { processed: 0, failed: 0, pending: pending.length };
    for (let offset = 0; offset < queue.length; offset += EXTRACTION_BATCH_SIZE) {
      const batch = queue.slice(offset, offset + EXTRACTION_BATCH_SIZE);
      count += batch.length;
      await store.setSetting(DAY_COUNTER_KEY, JSON.stringify({ day: today, count }));
      const outcomes = await Promise.allSettled(
        batch.map((entry) => this.deps.extract(entry.source, entry.candidates)),
      );
      let interrupted = false;
      for (const [index, outcome] of outcomes.entries()) {
        const entry = batch[index];
        if (!entry) {
          continue;
        }
        if (outcome.status === 'fulfilled') {
          await store.setSetting(`${LEDGER_PREFIX}${entry.ledgerKey}`, 'done');
          report.processed += 1;
          report.pending -= 1;
        } else if (outcome.reason instanceof ExtractionFormatError) {
          await store.setSetting(`${LEDGER_PREFIX}${entry.ledgerKey}`, 'failed');
          report.failed += 1;
          report.pending -= 1;
        } else {
          interrupted = true;
          this.deps.onLog(`[brain] extraction interrompue : ${errorMessage(outcome.reason)}`);
        }
      }
      if (interrupted) {
        break;
      }
    }
    return report;
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  private async timezone(): Promise<string> {
    return (await this.deps.store.getSetting(TIMEZONE_SETTING)) || DEFAULT_TIMEZONE;
  }

  private async readLimit(): Promise<number> {
    const raw = await this.deps.store.getSetting(MAX_EXTRACTIONS_SETTING);
    const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_MAX_EXTRACTIONS_PER_DAY;
  }

  private async readCount(today: string): Promise<number> {
    const raw = await this.deps.store.getSetting(DAY_COUNTER_KEY);
    if (raw === null) {
      return 0;
    }
    try {
      const parsed = JSON.parse(raw) as { day?: unknown; count?: unknown };
      return parsed.day === today && typeof parsed.count === 'number' ? parsed.count : 0;
    } catch {
      return 0;
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

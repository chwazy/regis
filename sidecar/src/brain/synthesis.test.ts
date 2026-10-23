import { describe, expect, it, vi } from 'vitest';
import type { EntityCard, EntitySynthesis, Job } from '@regis/shared';
import {
  MIN_REFRESH_MS,
  SynthesisFormatError,
  SynthesisService,
  buildSynthesisPrompt,
  namedNumbers,
  needsSynthesis,
  parseSynthesisText,
  stripFigures,
  synthesisSignature,
  type SynthesisDeps,
  type SynthesisSaveInput,
} from './synthesis';

const NOW = new Date('2026-10-22T12:00:00.000Z');

function card(overrides: Partial<EntityCard> = {}): EntityCard {
  return {
    entity: {
      id: 'E1',
      kind: 'client',
      name: 'Fromagerie du Jorat',
      tagsJson: ['maintenance'],
      dataJson: {},
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    },
    synthesis: null,
    stats: { hoursLast30Days: 0, lastMessageAt: null },
    notes: [],
    facts: [],
    projects: [],
    documents: [],
    timeline: [{ id: 'I1', kind: 'message', at: NOW.toISOString(), text: 'Alarme récurrente cave 2' }],
    links: [],
    activeJobs: [],
    ...overrides,
  };
}

function synthesis(overrides: Partial<EntitySynthesis> = {}): EntitySynthesis {
  return {
    entityId: 'E1',
    text: 'Client historique.',
    sourceCount: 1,
    signature: 'old',
    jobId: null,
    generatedAt: NOW.toISOString(),
    ...overrides,
  };
}

describe('stripFigures', () => {
  it('drops sentences with amounts, hours or counts', () => {
    expect(
      stripFigures(
        'Client fidèle. Il reste 12 heures sur le budget. Offre de 4500 CHF envoyée. Visite à prévoir.',
      ),
    ).toBe('Client fidèle. Visite à prévoir.');
  });

  it('keeps numbers that belong to known names', () => {
    expect(stripFigures('L’alarme de la cave 2 revient. 3 visites ont eu lieu.', ['cave 2'])).toBe(
      'L’alarme de la cave 2 revient.',
    );
  });
});

describe('namedNumbers', () => {
  it('collects word-number phrases from names and activity, without the hours prefix', () => {
    const phrases = namedNumbers(
      card({
        timeline: [
          { id: 'I1', kind: 'message', at: null, text: 'Alarme récurrente cave 2' },
          { id: 'I2', kind: 'time_entry', at: null, text: '2h · Migration ligne 3' },
        ],
      }),
    );
    expect(phrases).toEqual(expect.arrayContaining(['cave 2', 'ligne 3']));
    expect(phrases.some((phrase) => phrase.includes('2h'))).toBe(false);
  });
});

describe('parseSynthesisText', () => {
  it('unwraps fences and quotes and collapses whitespace', () => {
    expect(parseSynthesisText('```\n« Client historique.\n\nVisite prévue. »\n```')).toBe(
      'Client historique. Visite prévue.',
    );
  });

  it('rejects a reply left empty once figures are removed', () => {
    expect(() => parseSynthesisText('Budget de 60 heures.')).toThrow(SynthesisFormatError);
  });
});

describe('needsSynthesis', () => {
  it('skips entities with nothing to summarize', () => {
    expect(needsSynthesis(card({ timeline: [] }), undefined, NOW)).toBe(false);
  });

  it('generates when missing, forced, or changed and old enough', () => {
    const current = card();
    const fresh = synthesis({ signature: 'other' });
    const stale = synthesis({
      signature: 'other',
      generatedAt: new Date(NOW.getTime() - MIN_REFRESH_MS).toISOString(),
    });
    expect(needsSynthesis(current, undefined, NOW)).toBe(true);
    expect(needsSynthesis(current, fresh, NOW)).toBe(false);
    expect(needsSynthesis(current, stale, NOW)).toBe(true);
    expect(needsSynthesis(current, fresh, NOW, true)).toBe(true);
    expect(
      needsSynthesis(
        current,
        synthesis({ signature: synthesisSignature(current), generatedAt: '2000-01-01T00:00:00.000Z' }),
        NOW,
      ),
    ).toBe(false);
  });
});

describe('buildSynthesisPrompt', () => {
  it('forbids figures and hides logged hours from the activity', () => {
    const prompt = buildSynthesisPrompt(
      card({ timeline: [{ id: 'I2', kind: 'time_entry', at: null, text: '2h · Refonte des alarmes' }] }),
    );
    expect(prompt).toContain('Do not write any figure');
    expect(prompt).toContain('time_entry: Refonte des alarmes');
    expect(prompt).not.toContain('2h');
  });
});

describe('SynthesisService', () => {
  function deps(resultText: string | null, status: Job['status'] = 'done') {
    const saved: SynthesisSaveInput[] = [];
    const job = { id: 'J1', status, resultText, error: null } as unknown as Job;
    const value: SynthesisDeps = {
      store: {
        listEntities: () => Promise.resolve([card().entity]),
        entityCard: () => Promise.resolve(card()),
        listSyntheses: () => Promise.resolve([]),
        saveSynthesis: (input) => {
          saved.push(input);
          return Promise.resolve(synthesis({ text: input.text, signature: input.signature }));
        },
        insertAutoLinks: vi.fn(() => Promise.resolve(1)),
      },
      runner: { start: vi.fn(() => Promise.resolve(job)), waitForEnd: () => Promise.resolve(job) },
      pickAgent: () => Promise.resolve({ agentId: 'ollama', reason: 'local' }),
      failJob: vi.fn(() => Promise.resolve()),
      now: () => NOW,
    };
    return { value, saved };
  }

  it('generates pending syntheses on the local agent and stores the signature', async () => {
    const { value, saved } = deps('Client historique pour la cave 2. Il y a 3 alarmes.');
    const report = await new SynthesisService(value).runPending();
    expect(report).toEqual({ generated: 1, failed: 0, pending: 0 });
    expect(saved[0]).toMatchObject({
      entityId: 'E1',
      text: 'Client historique pour la cave 2.',
      sourceCount: 1,
      signature: synthesisSignature(card()),
      jobId: 'J1',
    });
    expect(vi.mocked(value.runner.start).mock.calls[0]?.[0]).toMatchObject({
      kind: 'synthesis',
      agentId: 'ollama',
    });
  });

  it('marks the job failed when the reply has no usable sentence', async () => {
    const { value, saved } = deps('Total : 60 heures.');
    const report = await new SynthesisService(value).runPending();
    expect(report).toEqual({ generated: 0, failed: 1, pending: 0 });
    expect(saved).toEqual([]);
    expect(value.failJob).toHaveBeenCalledOnce();
  });

  it('stops the run when the agent itself fails', async () => {
    const { value } = deps(null, 'failed');
    const report = await new SynthesisService(value).runPending();
    expect(report).toEqual({ generated: 0, failed: 0, pending: 1 });
  });
});

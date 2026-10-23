import { describe, expect, it } from 'vitest';
import type { Job } from '@regis/shared';
import { NoEligibleAgentError } from '../routing/engine';
import {
  buildCustomWidgetPrompt,
  createCustomWidgetGenerator,
  CustomWidgetFormatError,
  parseCustomWidgetText,
} from './custom-generate';

const VALID = {
  title: 'Heures par client',
  itemKind: 'time_entry',
  filters: [],
  groupBy: 'data.project.name',
  aggregate: { fn: 'sum', field: 'data.hours' },
  render: 'bar',
};

function job(id: string, overrides: Partial<Job>): Job {
  return {
    id,
    parentId: null,
    agentId: 'a1',
    kind: 'extract',
    title: '',
    prompt: '',
    status: 'done',
    sessionId: null,
    cwd: null,
    costUsd: 0,
    tokensIn: 0,
    tokensOut: 0,
    routingReason: null,
    resultText: null,
    error: null,
    createdAt: '2026-10-22T08:00:00.000Z',
    startedAt: null,
    endedAt: null,
    ...overrides,
  };
}

describe('parseCustomWidgetText', () => {
  it('accepts a valid spec wrapped in prose and applies the default limit', () => {
    const spec = parseCustomWidgetText(`Voici : ${JSON.stringify(VALID)} !`);

    expect(spec.itemKind).toBe('time_entry');
    expect(spec.limit).toBe(10);
  });

  it('rejects text without JSON, schema violations and unknown fields', () => {
    expect(() => parseCustomWidgetText('pas de json')).toThrow(CustomWidgetFormatError);
    expect(() => parseCustomWidgetText(JSON.stringify({ ...VALID, render: 'pie' }))).toThrow(
      CustomWidgetFormatError,
    );
    expect(() =>
      parseCustomWidgetText(JSON.stringify({ ...VALID, groupBy: 'id; DROP TABLE items' })),
    ).toThrow(/Champ inconnu/);
    expect(() =>
      parseCustomWidgetText(JSON.stringify({ ...VALID, aggregate: { fn: 'sum', field: 'title' } })),
    ).toThrow(/numérique/);
  });
});

describe('buildCustomWidgetPrompt', () => {
  it('lists the allowed fields and forbids code', () => {
    const prompt = buildCustomWidgetPrompt('heures par client');

    expect(prompt).toContain('data.project.name');
    expect(prompt).toContain('Never write SQL');
  });
});

describe('createCustomWidgetGenerator', () => {
  function setup(results: Partial<Job>[]) {
    const failed: string[] = [];
    let index = 0;
    const generate = createCustomWidgetGenerator({
      route: () => Promise.resolve({ agentId: 'a1', ruleId: null, reason: 'test', viaFallback: false }),
      runner: {
        start: () => {
          index += 1;
          return Promise.resolve(job(`j${String(index)}`, {}));
        },
        waitForEnd: (jobId) => Promise.resolve(job(jobId, results[index - 1] ?? {})),
      },
      failJob: (jobId) => {
        failed.push(jobId);
        return Promise.resolve();
      },
    });
    return { generate, failed };
  }

  it('retries once after an invalid answer', async () => {
    const { generate, failed } = setup([
      { resultText: '{"title":1}' },
      { resultText: JSON.stringify(VALID) },
    ]);

    expect((await generate('x')).title).toBe('Heures par client');
    expect(failed).toEqual(['j1']);
  });

  it('throws the validation error after two invalid answers', async () => {
    const { generate } = setup([{ resultText: 'non' }, { resultText: 'non plus' }]);

    await expect(generate('x')).rejects.toBeInstanceOf(CustomWidgetFormatError);
  });

  it('propagates a routing failure', async () => {
    const generate = createCustomWidgetGenerator({
      route: () => Promise.reject(new NoEligibleAgentError('aucun')),
      runner: {
        start: () => Promise.reject(new Error('unused')),
        waitForEnd: () => Promise.reject(new Error('unused')),
      },
      failJob: () => Promise.resolve(),
    });

    await expect(generate('x')).rejects.toBeInstanceOf(NoEligibleAgentError);
  });
});

import { describe, expect, it } from 'vitest';
import type { Job } from '@regis/shared';
import { buildJobTree } from './job-tree';

function job(id: string, overrides: Partial<Job> = {}): Job {
  return {
    id,
    parentId: null,
    agentId: 'a1',
    kind: 'task',
    title: id,
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
    createdAt: `2026-01-01T00:00:${id.slice(-2).padStart(2, '0')}.000Z`,
    startedAt: null,
    endedAt: null,
    ...overrides,
  };
}

describe('buildJobTree', () => {
  it('shows sub-jobs under their parent with increasing depth', () => {
    const jobs = [
      job('j01', { status: 'running' }),
      job('j02', { parentId: 'j01', status: 'running' }),
      job('j03', { parentId: 'j02', status: 'queued' }),
    ];

    const tree = buildJobTree(jobs, 'j02');

    expect(tree.map((node) => [node.job.id, node.depth])).toEqual([
      ['j01', 0],
      ['j02', 1],
      ['j03', 2],
    ]);
  });

  it('hides finished trees except the one being viewed', () => {
    const jobs = [
      job('j01'),
      job('j02', { parentId: 'j01' }),
      job('j03', { status: 'running' }),
      job('j04', { parentId: 'j03', status: 'done' }),
    ];

    expect(buildJobTree(jobs, undefined).map((node) => node.job.id)).toEqual(['j03', 'j04']);
    expect(buildJobTree(jobs, 'j02').map((node) => node.job.id)).toEqual(['j03', 'j04', 'j01', 'j02']);
  });

  it('keeps the ancestors of an active sub-job so it is not orphaned', () => {
    const jobs = [job('j01', { kind: 'chat' }), job('j02', { parentId: 'j01', status: 'waiting_approval' })];

    expect(buildJobTree(jobs, undefined).map((node) => [node.job.id, node.depth])).toEqual([
      ['j01', 0],
      ['j02', 1],
    ]);
  });
});

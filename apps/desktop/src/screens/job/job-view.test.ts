import { describe, expect, it } from 'vitest';
import type { Entity, JobEvent } from '@regis/shared';
import {
  describeContextRef,
  eventDetail,
  timelineSummaries,
  formatCost,
  formatDuration,
  formatTokens,
  isActive,
  jobKindLabel,
  mergeEvent,
  readStartInfo,
} from './job-view';

function event(id: number, overrides: Partial<JobEvent> = {}): JobEvent {
  return {
    id,
    jobId: 'j1',
    seq: id,
    at: '2026-01-01T00:00:00.000Z',
    type: 'message',
    summary: 's',
    payloadJson: {},
    ...overrides,
  };
}

describe('job view helpers', () => {
  it('formats durations for running and ended jobs', () => {
    const started = '2026-01-01T08:00:00.000Z';

    expect(formatDuration(null, null, 0)).toBe('—');
    expect(formatDuration(started, null, Date.parse('2026-01-01T08:00:20.000Z'))).toBe('< 1 min');
    expect(formatDuration(started, '2026-01-01T08:06:10.000Z', 0)).toBe('6 min');
    expect(formatDuration(started, '2026-01-01T10:05:00.000Z', 0)).toBe('2 h 05');
  });

  it('formats tokens and cost', () => {
    expect(formatTokens(48_200)).toBe('48.2k');
    expect(formatTokens(950)).toBe('950');
    expect(formatCost(0)).toBe('0 USD');
    expect(formatCost(0.00028688)).toBe('≈ 0.0003 USD');
    expect(formatCost(1.234)).toBe('≈ 1.23 USD');
  });

  it('reads the worktree, model and context from the first start event', () => {
    const info = readStartInfo([
      event(1, {
        type: 'start',
        payloadJson: {
          model: 'haiku',
          cwd: 'C:/data/jobs/J1',
          worktree: { repoPath: 'C:/repo', branch: 'regis/job-J1' },
          contextRefs: [{ type: 'client', id: 'c1' }, { nope: true }],
        },
      }),
      event(2, { type: 'start', payloadJson: { model: 'other', resumed: true } }),
    ]);

    expect(info).toEqual({
      model: 'haiku',
      cwd: 'C:/data/jobs/J1',
      worktree: { repoPath: 'C:/repo', branch: 'regis/job-J1' },
      contextRefs: [{ type: 'client', id: 'c1' }],
    });
    expect(readStartInfo([])).toEqual({ model: null, cwd: null, worktree: null, contextRefs: [] });
  });

  it('does not repeat the last message in the summary of the end event', () => {
    const reply = { role: 'assistant', text: 'Bonjour' };
    const events = [
      event(1, { type: 'start', summary: 'Démarrage' }),
      event(2, { summary: 'Bonjour', payloadJson: reply }),
      event(3, { type: 'end', summary: 'Bonjour', payloadJson: { resultText: 'Bonjour', isError: false } }),
      event(4, { type: 'end', summary: 'Autre', payloadJson: { resultText: 'Autre', isError: false } }),
      event(5, { type: 'end', summary: 'Bonjour', payloadJson: { resultText: 'Bonjour', isError: true } }),
    ];
    expect(timelineSummaries(events)).toEqual([
      'Démarrage',
      'Bonjour',
      'Terminé',
      'Autre',
      'Terminé en erreur',
    ]);
  });

  it('shows the tool name as the detail of a tool call', () => {
    expect(eventDetail(event(1, { type: 'tool_call', payloadJson: { tool: 'mcp__x__y' } }))).toBe(
      'mcp__x__y',
    );
    expect(eventDetail(event(2))).toBe('');
  });

  it('merges live events without duplicates and keeps the sequence order', () => {
    const merged = mergeEvent(mergeEvent([event(2)], event(1)), event(2));

    expect(merged.map((entry) => entry.id)).toEqual([1, 2]);
  });

  it('considers queued, running and waiting jobs as active', () => {
    expect(
      ['queued', 'running', 'waiting_approval', 'done'].map((status) => isActive(status as never)),
    ).toEqual([true, true, true, false]);
  });

  it('labels tasks and sub-tasks', () => {
    expect(jobKindLabel({ kind: 'task', parentId: null })).toBe('Tâche');
    expect(jobKindLabel({ kind: 'task', parentId: 'p' })).toBe('Sous-tâche');
    expect(jobKindLabel({ kind: 'chat', parentId: null })).toBe('Conversation');
  });

  it('describes context references with readable labels', () => {
    const entities = [{ id: 'e1', kind: 'project', name: 'Site web' }] as Entity[];

    expect(describeContextRef({ type: 'entity', id: 'e1' }, entities)).toEqual({
      kindLabel: 'Projet',
      name: 'Site web',
      to: '/cerveau?entity=e1',
    });
    expect(describeContextRef({ type: 'client', id: 'zz' }, entities)).toEqual({
      kindLabel: 'Client',
      name: null,
      to: null,
    });
    expect(describeContextRef({ type: 'file', id: 'f1' }, entities).kindLabel).toBe('Fichier');
    expect(describeContextRef({ type: 'weird', id: 'x' }, entities).kindLabel).toBe('Référence');
  });
});

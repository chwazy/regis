import { describe, expect, it } from 'vitest';
import type { Agent, Job, JobEvent } from '@regis/shared';
import { newAgentDraft } from '../agent-settings/agent-labels';
import {
  activeJobRows,
  activityKpis,
  agentActivity,
  agentState,
  budgetLine,
  isAgentAvailable,
  isAgentSimulated,
  runtimeSummary,
  dayKey,
  finishedToday,
  lastToolActivity,
  watchList,
} from './activity';

const TZ = 'Europe/Zurich';
const NOW = new Date('2026-10-22T14:00:00.000Z');

function job(id: string, overrides: Partial<Job> = {}): Job {
  return {
    id,
    parentId: null,
    agentId: 'a1',
    kind: 'task',
    title: id,
    prompt: 'p',
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
    startedAt: '2026-10-22T08:00:00.000Z',
    endedAt: '2026-10-22T08:05:00.000Z',
    ...overrides,
  };
}

function agent(overrides: Partial<Agent> = {}): Agent {
  return { ...newAgentDraft(), id: 'a1', name: 'API', ...overrides };
}

function toolCall(seq: number, payloadJson: unknown): JobEvent {
  return {
    id: seq,
    jobId: 'j1',
    seq,
    at: '2026-10-22T13:59:50.000Z',
    type: 'tool_call',
    summary: '',
    payloadJson,
  };
}

describe('activity helpers', () => {
  it('computes the day in the app timezone', () => {
    expect(dayKey('2026-10-21T22:30:00.000Z', TZ)).toBe('2026-10-22');
    expect(dayKey('2026-10-21T21:30:00.000Z', TZ)).toBe('2026-10-21');
  });

  it('keeps only jobs finished today, newest first', () => {
    const jobs = [
      job('old', { endedAt: '2026-10-21T10:00:00.000Z', createdAt: '2026-10-21T09:00:00.000Z' }),
      job('early'),
      job('late', { endedAt: '2026-10-22T12:00:00.000Z' }),
      job('running', { status: 'running', endedAt: null }),
    ];

    expect(finishedToday(jobs, NOW, TZ).map((entry) => entry.id)).toEqual(['late', 'early']);
  });

  it('sums today’s cost and counts outcomes', () => {
    const jobs = [
      job('a', { costUsd: 0.5, tokensIn: 100, tokensOut: 50 }),
      job('b', { status: 'failed', costUsd: 0.1 }),
      job('c', { status: 'running', endedAt: null, parentId: 'x', costUsd: 0.2 }),
      job('y', { createdAt: '2026-10-21T08:00:00.000Z', endedAt: '2026-10-21T09:00:00.000Z', costUsd: 9 }),
    ];

    const kpis = activityKpis(jobs, NOW, TZ);

    expect(kpis).toMatchObject({ active: 1, subAgents: 1, doneToday: 1, failedToday: 1, tokensToday: 150 });
    expect(kpis.costTodayUsd).toBeCloseTo(0.8);
  });

  it('nests active children under their active parent', () => {
    const jobs = [
      job('p', { status: 'running', createdAt: '2026-10-22T09:00:00.000Z' }),
      job('c', { status: 'running', parentId: 'p', createdAt: '2026-10-22T09:10:00.000Z' }),
      job('q', { status: 'waiting_approval', createdAt: '2026-10-22T10:00:00.000Z' }),
      job('done'),
    ];

    expect(activeJobRows(jobs).map((row) => [row.job.id, row.isChild])).toEqual([
      ['q', false],
      ['p', false],
      ['c', true],
    ]);
  });

  it('describes agent state from its jobs', () => {
    const jobs = [job('w', { status: 'waiting_approval', endedAt: null })];
    const activity = agentActivity('a1', jobs, NOW, TZ);

    expect(agentState(agent(), activity).text).toBe('bloqué');
    expect(agentState(agent({ enabled: false }), activity).text).toBe('désactivé');
    expect(agentState(agent(), agentActivity('a1', [], NOW, TZ)).text).toBe('au repos');
  });

  it('reads the last tool call and its main argument', () => {
    const events = [
      toolCall(1, { tool: 'Read', input: { file_path: 'a.cs' } }),
      toolCall(2, { tool: 'Bash', input: { command: 'dotnet test\nmore' } }),
    ];

    expect(lastToolActivity(events)).toEqual({ tool: 'Bash', argument: 'dotnet test', at: events[1]?.at });
    expect(lastToolActivity([])).toBeNull();
  });

  it('flags failures, budgets near the limit and missing runtimes', () => {
    const agents = [
      agent({ budgetDailyUsd: 1, secretRef: 'regis:a1' }),
      agent({ id: 'a2', name: 'CLI', runtime: 'claude-cli' }),
    ];
    const jobs = [job('f', { status: 'failed', title: 'Import PDF', costUsd: 0.85 })];

    expect(watchList(agents, jobs, {}, NOW, TZ).map((item) => item.kind)).toEqual([
      'failed',
      'budget',
      'missing',
    ]);
    expect(watchList(agents, [], null, NOW, TZ)).toEqual([]);
  });

  it('reports a simulated Claude CLI as available and labels it', () => {
    const cli = agent({ runtime: 'claude-cli' });
    const detect = { claude: { path: 'fake/claude', version: '2.1.306', simulated: true } };

    expect(isAgentAvailable(cli, detect)).toBe(true);
    expect(isAgentSimulated(cli, detect)).toBe(true);
    expect(runtimeSummary(cli, detect)).toBe('Claude Code (CLI) · Simulé (démo)');
    expect(watchList([cli], [], detect, NOW, TZ)).toEqual([]);
    expect(runtimeSummary(cli, {})).toBe('Claude Code (CLI) · indisponible');
  });

  it('formats the budget line with one currency format', () => {
    expect(budgetLine(0.123, 5)).toBe('≈ 0.12 USD / 5.00 USD');
  });
});

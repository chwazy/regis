import { describe, expect, it } from 'vitest';
import type { Item, Job } from '@regis/shared';
import { createBriefCollector, weekEndOf, weekStartOf, type BriefCollectDeps } from './collect';
import { makeApproval, makeEvent, makeItem, makeMail, makeProject, makeTimeEntry } from './test-support';

const NOW = new Date('2026-10-22T08:00:00.000Z');

const RUNNING_JOB: Job = {
  id: 'j1',
  parentId: null,
  agentId: 'a1',
  kind: 'task',
  title: 'Job',
  prompt: '',
  status: 'running',
  sessionId: null,
  cwd: null,
  costUsd: 0,
  tokensIn: 0,
  tokensOut: 0,
  routingReason: null,
  resultText: null,
  error: null,
  createdAt: '2026-10-22T07:00:00.000Z',
  startedAt: null,
  endedAt: null,
};

function deps(items: Item[], settings: Record<string, string> = {}): BriefCollectDeps {
  return {
    listItems: ({ kind }) => Promise.resolve(items.filter((item) => item.kind === kind)),
    listLinks: () => Promise.resolve([]),
    listPendingApprovals: () => Promise.resolve([makeApproval('a1')]),
    listJobs: (status) => Promise.resolve(status === 'running' ? [RUNNING_JOB] : []),
    getSetting: (key) => Promise.resolve(settings[key] ?? null),
  };
}

describe('weekStartOf / weekEndOf', () => {
  it('returns the ISO week bounds (Monday to Sunday)', () => {
    expect([weekStartOf('2026-10-22'), weekEndOf('2026-10-22')]).toEqual(['2026-10-19', '2026-10-25']);
    expect([weekStartOf('2026-10-25'), weekStartOf('2026-10-19')]).toEqual(['2026-10-19', '2026-10-19']);
  });
});

describe('collectBriefData', () => {
  const project = { id: 1, name: 'Ligne 3' };

  it('sums the time entries of the current ISO week only', async () => {
    const items = [
      makeTimeEntry('2026-10-19', 3, project),
      makeTimeEntry('2026-10-22', 2.5, project),
      makeTimeEntry('2026-10-21', 1, { id: 2, name: 'Autre' }),
      makeTimeEntry('2026-10-18', 8, project),
      makeTimeEntry('2026-10-26', 8, project),
    ];

    const data = await createBriefCollector(deps(items))(NOW);

    expect(data.weekTotal).toBe(6.5);
    expect(data.weekHours).toEqual([
      { projectName: 'Ligne 3', hours: 5.5 },
      { projectName: 'Autre', hours: 1 },
    ]);
    expect(data.weekTarget).toBe(40);
  });

  it('reads the weekly target from the setting', async () => {
    const data = await createBriefCollector(deps([], { 'brief.weeklyHoursTarget': '36' }))(NOW);

    expect(data.weekTarget).toBe(36);
  });

  it('keeps only invoices flagged overdue', async () => {
    const overdue = makeItem('invoice', { dataJson: { overdue: true } });
    const items = [
      overdue,
      makeItem('invoice', { dataJson: { overdue: false } }),
      makeItem('invoice', { dataJson: {} }),
    ];

    const data = await createBriefCollector(deps(items))(NOW);

    expect(data.overdueInvoices).toEqual([overdue]);
  });

  it('keeps unread mails of the last 48 hours, newest first', async () => {
    const recent = makeMail({ occurredAt: '2026-10-22T06:00:00.000Z' });
    const older = makeMail({ occurredAt: '2026-10-21T06:00:00.000Z' });
    const items = [
      older,
      recent,
      makeMail({ isRead: true }),
      makeMail({ occurredAt: '2026-10-19T06:00:00.000Z' }),
    ];

    const data = await createBriefCollector(deps(items))(NOW);

    expect(data.unreadMails).toEqual([recent, older]);
  });

  it('keeps the events of today in the app timezone', async () => {
    const today = makeEvent('2026-10-22T08:00:00.000Z', '2026-10-22T09:00:00.000Z');
    const lateYesterdayUtc = makeEvent('2026-10-21T21:30:00.000Z', '2026-10-21T22:00:00.000Z');
    const tomorrow = makeEvent('2026-10-23T08:00:00.000Z', '2026-10-23T09:00:00.000Z');

    const data = await createBriefCollector(deps([today, lateYesterdayUtc, tomorrow]))(NOW);

    expect(data.date).toBe('2026-10-22');
    expect(data.todayEvents).toEqual([today]);
  });

  it('adds pending approvals, active jobs and hour suggestions', async () => {
    const event = makeEvent('2026-10-22T06:00:00.000Z', '2026-10-22T07:00:00.000Z', {
      title: 'Revue Ligne 3',
    });

    const data = await createBriefCollector(deps([event, makeProject(1, 'Ligne 3')]))(NOW);

    expect(data.pendingApprovals.map((approval) => approval.id)).toEqual(['a1']);
    expect(data.activeJobs.map((job) => job.id)).toEqual(['j1']);
    expect(data.hourSuggestions.map((suggestion) => suggestion.hours)).toEqual([1]);
  });
});

import { describe, expect, it } from 'vitest';
import type { Entity, Job, Link } from '@regis/shared';
import { makeAgent } from '../agents/test-support';
import { budgetRemainingPct, buildRoutingContext, calendarDay } from './context';

const entity = (id: string, kind: Entity['kind'], tags: string[]): Entity => ({
  id,
  kind,
  name: id,
  tagsJson: tags,
  dataJson: {},
  createdAt: '',
  updatedAt: '',
});
const link = (fromType: string, fromId: string, toType: string, toId: string): Link => ({
  id: `${fromId}-${toId}`,
  fromType,
  fromId,
  toType,
  toId,
  rel: 'about',
  origin: 'user',
  confidence: null,
  createdAt: '',
});
const job = (agentId: string, costUsd: number, createdAt: string): Job =>
  ({ agentId, costUsd, createdAt }) as Job;

describe('buildRoutingContext', () => {
  it('resolves client, project and tags through links', async () => {
    const ctx = await buildRoutingContext(
      {
        listEntities: () =>
          Promise.resolve([
            entity('c1', 'client', ['nda']),
            entity('p1', 'project', []),
            entity('c2', 'client', []),
          ]),
        listLinks: () =>
          Promise.resolve([link('file', 'f1', 'entity', 'c1'), link('entity', 'p1', 'item', 'i1')]),
        listJobs: () => Promise.resolve([]),
        listAgents: () => Promise.resolve([]),
        getSetting: () => Promise.resolve(null),
        now: () => new Date('2026-03-04T11:00:00Z'),
      },
      {
        task: 't',
        taskType: 'code',
        contextRefs: [
          { type: 'file', id: 'f1' },
          { type: 'item', id: 'i1' },
        ],
      },
    );

    expect(ctx).toMatchObject({
      clientIds: ['c1'],
      projectIds: ['p1'],
      entityTags: ['nda'],
      taskType: 'code',
      timezone: 'Europe/Zurich',
    });
  });
});

describe('budgetRemainingPct', () => {
  it('counts only the spend of the current day in the app timezone', () => {
    const agent = makeAgent({ id: 'api', budgetDailyUsd: 10 });
    const now = new Date('2026-03-04T12:00:00Z');
    const jobs = [
      job('api', 8.5, '2026-03-04T08:00:00Z'),
      job('api', 5, '2026-03-03T08:00:00Z'),
      job('other', 5, '2026-03-04T08:00:00Z'),
    ];

    expect(budgetRemainingPct([agent, makeAgent({ id: 'free' })], jobs, now, 'Europe/Zurich')).toEqual({
      api: 15,
    });
  });

  it('uses the timezone to decide the calendar day', () => {
    expect(calendarDay(new Date('2026-03-04T23:30:00Z'), 'Europe/Zurich')).toBe('2026-03-05');
  });
});

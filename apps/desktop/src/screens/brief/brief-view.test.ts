import { describe, expect, it } from 'vitest';
import type { BriefData, HourSuggestion, Item } from '@regis/shared';
import {
  deterministicHeadline,
  eventMeta,
  formatBriefDate,
  formatHours,
  formatMailTime,
  formatTime,
  initialsOf,
  progressPercent,
  timesheetJobPrompt,
  timesheetJobTitle,
} from './brief-view';

const SUGGESTION: HourSuggestion = {
  eventItemId: 'e1',
  projectExternalId: 42,
  projectName: 'Ligne 3',
  date: '2026-10-22',
  hours: 1.5,
  description: 'Revue',
};

function item(overrides: Partial<Item>): Item {
  return {
    id: 'i1',
    connectorId: 'c1',
    kind: 'event',
    externalId: '1',
    title: 't',
    bodyText: null,
    occurredAt: null,
    dataJson: {},
    updatedAt: '2026-10-22T00:00:00.000Z',
    ...overrides,
  };
}

describe('formatHours', () => {
  it('formats whole hours and minutes', () => {
    expect(formatHours(40)).toBe('40h');
    expect(formatHours(35.3333)).toBe('35h20');
    expect(formatHours(0.5)).toBe('0h30');
  });
});

describe('progressPercent', () => {
  it('rounds and caps at 100', () => {
    expect(progressPercent(35.3333, 40)).toBe(88);
    expect(progressPercent(50, 40)).toBe(100);
    expect(progressPercent(5, 0)).toBe(0);
  });
});

describe('formatBriefDate', () => {
  it('formats the calendar date in French without timezone drift', () => {
    expect(formatBriefDate('2026-10-22')).toBe('Jeudi 22 octobre');
  });
});

describe('time formatting', () => {
  it('formats a time in the app timezone', () => {
    expect(formatTime('2026-10-22T07:30:00.000Z', 'Europe/Zurich')).toBe('09:30');
  });

  it('shows the time for today and "hier" otherwise', () => {
    const now = new Date('2026-10-22T10:00:00.000Z');

    expect(formatMailTime('2026-10-22T06:12:00.000Z', now, 'Europe/Zurich')).toBe('08:12');
    expect(formatMailTime('2026-10-21T15:00:00.000Z', now, 'Europe/Zurich')).toBe('hier');
  });
});

describe('deterministicHeadline', () => {
  it('counts mails, events and approvals from the data', () => {
    const data = {
      unreadMails: [item({}), item({})],
      todayEvents: [item({})],
      pendingApprovals: [],
    } as unknown as BriefData;

    expect(deterministicHeadline(data)).toBe('2 mails importants, 1 événements, 0 validations en attente');
  });
});

describe('initialsOf / eventMeta', () => {
  it('builds up to two initials', () => {
    expect(initialsOf('Marc Keller')).toBe('MK');
    expect(initialsOf('odoo@example.com')).toBe('OE');
  });

  it('joins location and duration', () => {
    const event = item({
      occurredAt: '2026-10-22T08:00:00.000Z',
      dataJson: { end: '2026-10-22T09:30:00.000Z', location: 'Teams' },
    });

    expect(eventMeta(event)).toBe('Teams · 1h30');
  });
});

describe('timesheet job', () => {
  it('names the project and the hours in the title', () => {
    expect(timesheetJobTitle(SUGGESTION)).toBe('Saisir 1h30 sur Ligne 3');
  });

  it('asks for exactly one timesheet_create call with the suggested arguments', () => {
    const prompt = timesheetJobPrompt(SUGGESTION);

    expect(prompt).toContain('mcp__odoo__timesheet_create');
    expect(prompt).toContain(
      JSON.stringify({ projectId: 42, date: '2026-10-22', hours: 1.5, description: 'Revue' }),
    );
  });
});

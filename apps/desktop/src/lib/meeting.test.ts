import { describe, expect, it } from 'vitest';
import type { Item } from '@regis/shared';
import { canJoin, meetingJoinInfo } from './meeting';

function event(data: Record<string, unknown>, kind: Item['kind'] = 'event'): Item {
  return {
    id: 'i1',
    connectorId: 'c1',
    kind,
    externalId: 'e1',
    title: 'Réunion',
    bodyText: null,
    occurredAt: '2026-10-23T13:00:00.000Z',
    dataJson: { end: '2026-10-23T13:30:00.000Z', ...data },
    updatedAt: '2026-10-22T00:00:00.000Z',
  };
}

const TEAMS = event({
  onlineMeetingUrl: 'https://teams.microsoft.com/l/meetup-join/synthetic-0003',
  onlineMeetingProvider: 'teamsForBusiness',
});

describe('meetingJoinInfo', () => {
  it('describes a Teams meeting', () => {
    expect(meetingJoinInfo(TEAMS)).toMatchObject({ provider: 'teams', host: 'teams.microsoft.com' });
  });

  it('detects Teams from the host when the provider is missing', () => {
    const info = meetingJoinInfo(event({ onlineMeetingUrl: 'https://teams.live.com/meet/1' }));
    expect(info?.provider).toBe('teams');
  });

  it('flags other providers', () => {
    expect(meetingJoinInfo(event({ onlineMeetingUrl: 'https://meet.example.test/x' }))?.provider).toBe(
      'other',
    );
  });

  it('returns null for cancelled, http, javascript, missing and non-event items', () => {
    expect(
      meetingJoinInfo({ ...TEAMS, dataJson: { ...(TEAMS.dataJson as object), isCancelled: true } }),
    ).toBeNull();
    expect(meetingJoinInfo(event({ onlineMeetingUrl: 'http://teams.microsoft.com/x' }))).toBeNull();
    expect(meetingJoinInfo(event({ onlineMeetingUrl: 'javascript:alert(1)' }))).toBeNull();
    expect(meetingJoinInfo(event({ onlineMeetingUrl: null }))).toBeNull();
    expect(meetingJoinInfo(event({ onlineMeetingUrl: 'not a url' }))).toBeNull();
    expect(
      meetingJoinInfo(event({ onlineMeetingUrl: 'https://teams.microsoft.com/x' }, 'message')),
    ).toBeNull();
  });
});

describe('canJoin', () => {
  it('is true during the meeting and 30 minutes before', () => {
    expect(canJoin(TEAMS, new Date('2026-10-23T12:30:00.000Z'))).toBe(true);
    expect(canJoin(TEAMS, new Date('2026-10-23T13:10:00.000Z'))).toBe(true);
    expect(canJoin(TEAMS, new Date('2026-10-23T13:30:00.000Z'))).toBe(true);
  });

  it('is false one minute after the end', () => {
    expect(canJoin(TEAMS, new Date('2026-10-23T13:31:00.000Z'))).toBe(false);
  });

  it('is false without a valid link', () => {
    expect(canJoin(event({ onlineMeetingUrl: null }), new Date('2026-10-23T13:00:00.000Z'))).toBe(false);
  });
});

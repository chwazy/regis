import { describe, expect, it } from 'vitest';
// @ts-expect-error script .mjs sans déclaration de types
import { anonymizeCalendar } from './ms365-calendar.mjs';

interface Anonymized {
  value: {
    id: string;
    subject: string;
    organizer: { emailAddress: { address: string } };
    onlineMeeting: { joinUrl: string };
    onlineMeetingProvider: string;
  }[];
}

const RAW = {
  value: [
    {
      id: 'AAMkRealId==',
      subject: 'Budget Dupont',
      bodyPreview: 'Confidentiel',
      webLink: 'https://outlook.office.com/owa/?itemid=REAL',
      location: { displayName: 'Salle Léman' },
      organizer: { emailAddress: { name: 'Jean Dupont', address: 'jean.dupont@contoso.com' } },
      attendees: [{ emailAddress: { name: 'Marie Martin', address: 'marie@contoso.com' } }],
      onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/19%3Ameeting_REAL%40thread.v2/0' },
      onlineMeetingProvider: 'teamsForBusiness',
    },
    {
      id: 'AAMkOther',
      subject: 'Autre',
      onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/other' },
    },
  ],
};

describe('anonymizeCalendar', () => {
  const out = anonymizeCalendar(RAW) as Anonymized;
  const text = JSON.stringify(out);

  it('removes subjects, names, addresses and ids', () => {
    for (const secret of ['Dupont', 'Martin', 'contoso', 'REAL', 'Léman', 'Confidentiel', 'Budget']) {
      expect(text).not.toContain(secret);
    }
    expect(out.value[0]?.organizer.emailAddress.address).toMatch(/@example\.test$/);
    expect(out.value[0]?.id).toMatch(/^AAMkSYNTHETIC/);
  });

  it('replaces the joinUrl path by synthetic-<n> and keeps the host', () => {
    expect(out.value[0]?.onlineMeeting.joinUrl).toBe('https://teams.microsoft.com/synthetic-1');
    expect(out.value[1]?.onlineMeeting.joinUrl).toBe('https://teams.microsoft.com/synthetic-2');
  });

  it('keeps non identifying fields and is deterministic', () => {
    expect(out.value[0]?.onlineMeetingProvider).toBe('teamsForBusiness');
    expect(anonymizeCalendar(RAW)).toEqual(out);
  });

  it('does not mutate its input', () => {
    expect(RAW.value[0]?.subject).toBe('Budget Dupont');
  });
});

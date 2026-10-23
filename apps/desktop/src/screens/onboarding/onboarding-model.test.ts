import { describe, expect, it } from 'vitest';
import {
  PROFILES,
  STEPS,
  buildResumeUrl,
  defaultAgentCandidates,
  isKnownTimezone,
  parseResumeQuery,
  profileById,
  shouldShowOnboarding,
} from './onboarding-model';

describe('PROFILES', () => {
  it('lists the three profiles and six steps in order', () => {
    expect(PROFILES.map((profile) => profile.id)).toEqual(['complete', 'pro', 'brain']);
    expect(STEPS).toEqual(['profile', 'data', 'prereqs', 'connectors', 'agents', 'summary']);
  });

  it('brain only shows the brain and offers files', () => {
    const brain = profileById('brain');
    expect(brain.screens).toEqual({ brief: false, dashboard: false, brain: true });
    expect(brain.connectorSteps).toEqual(['files']);
  });

  it('pro offers m365, odoo and files', () => {
    expect(profileById('pro').connectorSteps).toEqual(['m365', 'odoo', 'files']);
  });
});

describe('profileById', () => {
  it('falls back to complete', () => {
    expect(profileById('inconnu').id).toBe('complete');
    expect(profileById(null).id).toBe('complete');
  });
});

describe('shouldShowOnboarding', () => {
  it('shows when not completed or forced', () => {
    expect(shouldShowOnboarding(null, false)).toBe(true);
    expect(shouldShowOnboarding('2026-10-22T10:00:00Z', false)).toBe(false);
    expect(shouldShowOnboarding('2026-10-22T10:00:00Z', true)).toBe(true);
  });
});

describe('parseResumeQuery', () => {
  it('reads profile and step', () => {
    expect(parseResumeQuery('?profile=pro&step=data')).toEqual({ profile: 'pro', step: 'data' });
    expect(parseResumeQuery('?profile=x')).toEqual({ profile: null, step: null });
    expect(parseResumeQuery('')).toEqual({ profile: null, step: null });
  });

  it('round-trips with buildResumeUrl', () => {
    const url = buildResumeUrl('brain', 'data');
    expect(url).toBe('/bienvenue?profile=brain&step=data');
    expect(parseResumeQuery(url.slice(url.indexOf('?')))).toEqual({ profile: 'brain', step: 'data' });
  });
});

describe('defaultAgentCandidates', () => {
  it('excludes disabled agents', () => {
    const agents = [
      { id: 'a', enabled: true },
      { id: 'b', enabled: false },
    ];
    expect(defaultAgentCandidates(agents)).toEqual([{ id: 'a', enabled: true }]);
  });
});

describe('isKnownTimezone', () => {
  it('checks membership', () => {
    expect(isKnownTimezone('Europe/Zurich', ['Europe/Zurich'])).toBe(true);
    expect(isKnownTimezone('Mars/Base', ['Europe/Zurich'])).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { isNavActive, isSettingsPath, pageLayout } from './layout';

describe('page layout', () => {
  it('gives each route family one width', () => {
    expect(pageLayout('/')).toBe('wide');
    expect(pageLayout('/agents')).toBe('full');
    expect(pageLayout('/jobs/01J')).toBe('wide');
    expect(pageLayout('/transcripts/01J')).toBe('narrow');
    expect(pageLayout('/reglages/agents')).toBe('wide');
    expect(pageLayout('/inconnu')).toBe('default');
  });

  it('keeps the parent tab active on detail pages', () => {
    const agents = { to: '/agents', also: ['/jobs/'] };

    expect(isNavActive(agents, '/jobs/01J')).toBe(true);
    expect(isNavActive(agents, '/agentsx')).toBe(false);
    expect(isNavActive({ to: '/' }, '/dashboard')).toBe(false);
  });

  it('recognises settings pages', () => {
    expect(isSettingsPath('/reglages')).toBe(true);
    expect(isSettingsPath('/reglages/voix')).toBe(true);
    expect(isSettingsPath('/reglagesx')).toBe(false);
  });
});

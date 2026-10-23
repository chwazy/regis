import { describe, expect, it } from 'vitest';
import { DEFAULT_UI_SCREENS, firstVisibleRoute, parseUiScreens } from './ui-screens';

describe('parseUiScreens', () => {
  it('returns the defaults when the setting is missing', () => {
    expect(parseUiScreens(null)).toEqual(DEFAULT_UI_SCREENS);
  });

  it('defaults the missing keys', () => {
    expect(parseUiScreens('{"brief":false}')).toEqual({ brief: false, dashboard: true, brain: true });
  });

  it('returns the defaults for invalid JSON or non-object values', () => {
    expect(parseUiScreens('pas du json')).toEqual(DEFAULT_UI_SCREENS);
    expect(parseUiScreens('[1]')).toEqual(DEFAULT_UI_SCREENS);
    expect(parseUiScreens('{"brief":"non"}')).toEqual(DEFAULT_UI_SCREENS);
  });
});

describe('firstVisibleRoute', () => {
  it('follows the NAV_ITEMS order', () => {
    expect(firstVisibleRoute({ brief: false, dashboard: false, brain: true })).toBe('/cerveau');
    expect(firstVisibleRoute({ brief: false, dashboard: true, brain: true })).toBe('/dashboard');
    expect(firstVisibleRoute(DEFAULT_UI_SCREENS)).toBe('/');
  });

  it('falls back to the agents screen when nothing is visible', () => {
    expect(firstVisibleRoute({ brief: false, dashboard: false, brain: false })).toBe('/agents');
  });
});

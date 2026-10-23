export type ScreenKey = 'brief' | 'dashboard' | 'brain';
export type UiScreens = Record<ScreenKey, boolean>;

export const UI_SCREENS_KEY = 'ui.screens';

export const DEFAULT_UI_SCREENS: UiScreens = { brief: true, dashboard: true, brain: true };

/** Ordre et routes des écrans de la nav principale (identique à NAV_ITEMS). */
export const SCREEN_ROUTES: readonly { key: ScreenKey; to: string }[] = [
  { key: 'brief', to: '/' },
  { key: 'dashboard', to: '/dashboard' },
  { key: 'brain', to: '/cerveau' },
];

const FALLBACK_ROUTE = '/agents';

export function parseUiScreens(raw: string | null): UiScreens {
  if (raw === null) {
    return { ...DEFAULT_UI_SCREENS };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_UI_SCREENS };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ...DEFAULT_UI_SCREENS };
  }
  const record = parsed as Record<string, unknown>;
  const read = (key: ScreenKey): boolean =>
    typeof record[key] === 'boolean' ? record[key] : DEFAULT_UI_SCREENS[key];
  return { brief: read('brief'), dashboard: read('dashboard'), brain: read('brain') };
}

export function firstVisibleRoute(screens: UiScreens): string {
  return SCREEN_ROUTES.find((screen) => screens[screen.key])?.to ?? FALLBACK_ROUTE;
}

import { useEffect, useState } from 'react';
import { invokeCmd, onRegisEvent } from './ipc';
import { DEFAULT_UI_SCREENS, parseUiScreens, UI_SCREENS_KEY, type UiScreens } from './ui-screens';

export function useUiScreens(): { screens: UiScreens; loaded: boolean } {
  const [state, setState] = useState<{ screens: UiScreens; loaded: boolean }>({
    screens: DEFAULT_UI_SCREENS,
    loaded: false,
  });

  useEffect(() => {
    let active = true;
    const load = () =>
      invokeCmd<string | null>('get_setting', { key: UI_SCREENS_KEY })
        .then((raw) => parseUiScreens(raw))
        .catch(() => DEFAULT_UI_SCREENS)
        .then((screens) => {
          if (active) {
            setState({ screens, loaded: true });
          }
        });
    void load();
    const unlisten = onRegisEvent<{ key: string }>('settings.changed', (event) => {
      if (event.payload.key === UI_SCREENS_KEY) {
        void load();
      }
    });
    return () => {
      active = false;
      void unlisten.then((stop) => stop());
    };
  }, []);

  return state;
}

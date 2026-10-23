import type { AppSettingsInfo } from '@regis/shared';
import { invokeCmd } from './ipc';

let cached: Promise<AppSettingsInfo> | undefined;

/**
 * `get_app_info` consomme `resumeUrl` (lecture unique côté Rust) : on garde la réponse
 * de la première lecture pour toute la session, y compris sous StrictMode.
 */
export function loadAppInfoOnce(): Promise<AppSettingsInfo> {
  cached ??= invokeCmd<AppSettingsInfo>('get_app_info').catch((reason: unknown) => {
    cached = undefined;
    throw reason;
  });
  return cached;
}

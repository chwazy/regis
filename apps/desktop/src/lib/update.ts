import type { UpdateInfo, UpdateProgress } from '@regis/shared';

export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const DISMISSED_UPDATE_KEY = 'updates.dismissedVersion';

export function shouldShowUpdateBanner(update: UpdateInfo | null, dismissedVersion: string | null): boolean {
  return update !== null && update.version !== dismissedVersion;
}

export function progressPercent(progress: UpdateProgress | null): number | null {
  if (progress === null || progress.total === null || progress.total <= 0) {
    return null;
  }
  return Math.min(100, Math.round((progress.downloaded / progress.total) * 100));
}

import { describe, expect, it } from 'vitest';
import type { UpdateInfo } from '@regis/shared';
import { progressPercent, shouldShowUpdateBanner } from './update';

const update: UpdateInfo = { version: '0.3.0', currentVersion: '0.2.0', notes: null };

describe('shouldShowUpdateBanner', () => {
  it('hides the banner when no update is available', () => {
    expect(shouldShowUpdateBanner(null, null)).toBe(false);
  });

  it('shows an available update that was never dismissed', () => {
    expect(shouldShowUpdateBanner(update, null)).toBe(true);
  });

  it('keeps a dismissed version hidden', () => {
    expect(shouldShowUpdateBanner(update, '0.3.0')).toBe(false);
  });

  it('shows a newer version again after an older one was dismissed', () => {
    expect(shouldShowUpdateBanner(update, '0.2.5')).toBe(true);
  });
});

describe('progressPercent', () => {
  it('is unknown without a total size', () => {
    expect(progressPercent(null)).toBeNull();
    expect(progressPercent({ downloaded: 10, total: null })).toBeNull();
    expect(progressPercent({ downloaded: 10, total: 0 })).toBeNull();
  });

  it('rounds and caps the downloaded share', () => {
    expect(progressPercent({ downloaded: 1, total: 3 })).toBe(33);
    expect(progressPercent({ downloaded: 12, total: 10 })).toBe(100);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { debounce } from './debounce';

describe('debounce', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs once, after the last trigger of a burst', () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    const debouncer = debounce(callback, 2000);

    debouncer.trigger();
    vi.advanceTimersByTime(1500);
    debouncer.trigger();
    vi.advanceTimersByTime(1500);
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('does not run after being cancelled', () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    const debouncer = debounce(callback, 2000);

    debouncer.trigger();
    debouncer.cancel();
    vi.advanceTimersByTime(5000);

    expect(callback).not.toHaveBeenCalled();
  });
});

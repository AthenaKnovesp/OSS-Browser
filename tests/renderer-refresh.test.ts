import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTrailingDebounce } from '../src/renderer/src/utils/trailingDebounce';

describe('object refresh debounce', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces 50 terminal task updates into one trailing refresh', () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    const debounce = createTrailingDebounce(refresh, 300);

    for (let index = 0; index < 50; index += 1) {
      debounce.schedule();
    }

    vi.advanceTimersByTime(299);
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

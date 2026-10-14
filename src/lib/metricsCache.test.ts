import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { get, set, invalidateMetrics, clearMetricsCache } from './metricsCache';
import { DASHBOARD_CACHE_TTL_MS } from './metricsConstants';

describe('metricsCache', () => {
  beforeEach(() => {
    clearMetricsCache();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns what was set and undefined for a missing key', () => {
    set('1:2026:all', { a: 1 });
    expect(get('1:2026:all')).toEqual({ a: 1 });
    expect(get('1:2025:all')).toBeUndefined();
  });

  it('expires entries after the TTL', () => {
    set('1:2026:all', { a: 1 });
    vi.advanceTimersByTime(DASHBOARD_CACHE_TTL_MS - 1);
    expect(get('1:2026:all')).toEqual({ a: 1 });
    vi.advanceTimersByTime(1);
    expect(get('1:2026:all')).toBeUndefined();
  });

  it('invalidates only the given account', () => {
    set('1:2026:all', 'one');
    set('1:2025:7', 'one-b');
    set('12:2026:all', 'twelve');
    invalidateMetrics(1);
    expect(get('1:2026:all')).toBeUndefined();
    expect(get('1:2025:7')).toBeUndefined();
    expect(get('12:2026:all')).toBe('twelve');
  });
});

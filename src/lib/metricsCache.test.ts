import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { get, set, invalidateMetrics, clearMetricsCache } from './metricsCache';
import { DASHBOARD_CACHE_MAX_BYTES, DASHBOARD_CACHE_MAX_ENTRIES, DASHBOARD_CACHE_TTL_MS } from './metricsConstants';

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
    vi.advanceTimersByTime(DASHBOARD_CACHE_TTL_MS);
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

  it('evicts the least recently used entry past the entry cap', () => {
    for (let i = 0; i <= DASHBOARD_CACHE_MAX_ENTRIES; i++) set(`${i}:2026:all`, { i });
    expect(get('0:2026:all')).toBeUndefined();
    expect(get('1:2026:all')).toEqual({ i: 1 });
    expect(get(`${DASHBOARD_CACHE_MAX_ENTRIES}:2026:all`)).toEqual({ i: DASHBOARD_CACHE_MAX_ENTRIES });
  });

  it('does not store a body bigger than the byte budget', () => {
    set('1:2026:all', { small: true });
    set('2:2026:all', { big: 'x'.repeat(DASHBOARD_CACHE_MAX_BYTES) });
    expect(get('2:2026:all')).toBeUndefined();
    expect(get('1:2026:all')).toEqual({ small: true });
  });
});

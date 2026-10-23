// In-memory cache for dashboard responses (Phase 49). Keys start with
// `${accountId}:` so a write can drop everything cached for one account. The
// colon keeps account 1 from matching account 12.
//
// Bounded LRU: at most DASHBOARD_CACHE_MAX_ENTRIES bodies and
// DASHBOARD_CACHE_MAX_BYTES of JSON; a body bigger than the whole budget is not
// stored. Bodies are wrapped because lru-cache won't store null/undefined.
// ttlResolution 0 + a perf that calls Date.now() each time: expiry reads the
// current global Date on every check, so fake timers in tests drive it.

import { LRUCache } from 'lru-cache';
import {
  DASHBOARD_CACHE_MAX_BYTES,
  DASHBOARD_CACHE_MAX_ENTRIES,
  DASHBOARD_CACHE_TTL_MS,
} from './metricsConstants';

const cache = new LRUCache<string, { body: unknown }>({
  max: DASHBOARD_CACHE_MAX_ENTRIES,
  maxSize: DASHBOARD_CACHE_MAX_BYTES,
  sizeCalculation: (entry) => Math.max(1, Buffer.byteLength(JSON.stringify(entry.body) ?? '')),
  ttl: DASHBOARD_CACHE_TTL_MS,
  ttlResolution: 0,
  perf: { now: () => Date.now() },
});

export function get(key: string): unknown | undefined {
  return cache.get(key)?.body;
}

export function set(key: string, body: unknown): void {
  cache.set(key, { body });
}

export function invalidateMetrics(accountId: number): void {
  const prefix = `${accountId}:`;
  for (const key of [...cache.keys()]) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

export function clearMetricsCache(): void {
  cache.clear();
}

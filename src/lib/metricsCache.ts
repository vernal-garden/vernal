// In-memory cache for dashboard responses (Phase 49). Keys start with
// `${accountId}:` so a write can drop everything cached for one account. The
// colon keeps account 1 from matching account 12.

import { DASHBOARD_CACHE_TTL_MS } from './metricsConstants';

interface CacheEntry {
  body: unknown;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

export function get(key: string): unknown | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return entry.body;
}

export function set(key: string, body: unknown): void {
  cache.set(key, { body, expiresAt: Date.now() + DASHBOARD_CACHE_TTL_MS });
}

export function invalidateMetrics(accountId: number): void {
  const prefix = `${accountId}:`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

export function clearMetricsCache(): void {
  cache.clear();
}

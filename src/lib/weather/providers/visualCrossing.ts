import { LRUCache } from 'lru-cache';
import { degreesToCompass } from '../compass';
import type { NormalizedReading, DailyHistoryPoint } from '../types';
import { UpstreamError, fetchProviderJson } from '../upstream';

export const HISTORY_TTL_MS = 60 * 60 * 1000;
const HISTORY_CACHE_MAX = 5000;
const KMH_PER_MS = 3.6;

// Read at call time (not module load) so unit tests can set them per test.
// The key never appears in an error or log line.
function base(): string {
  const value = process.env.VISUAL_CROSSING_BASE_URL || 'https://weather.visualcrossing.com';
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function apiKey(): string {
  const key = process.env.VISUAL_CROSSING_API_KEY;
  if (!key) throw new Error('Visual Crossing is not configured');
  return key;
}

function timelineUrl(lat: number, lon: number, period: string, params: Record<string, string>): string {
  const query = new URLSearchParams({
    unitGroup: 'metric',
    contentType: 'json',
    key: apiKey(),
    ...params,
  });
  return `${base()}/VisualCrossingWebServices/rest/services/timeline/${lat},${lon}/${period}?${query}`;
}

interface VisualCrossingCurrent {
  datetimeEpoch: number;
  temp?: number | null;
  humidity?: number | null;
  precip?: number | null;
  pressure?: number | null;
  windspeed?: number | null; // km/h
  winddir?: number | null;
  uvindex?: number | null;
}

export async function fetchCurrent(lat: number, lon: number): Promise<NormalizedReading> {
  const url = timelineUrl(lat, lon, 'today', {
    include: 'current',
    elements: 'datetimeEpoch,temp,humidity,precip,pressure,windspeed,winddir,uvindex',
  });

  const body = await fetchProviderJson<{ currentConditions?: VisualCrossingCurrent }>('Visual Crossing', url);
  const current = body.currentConditions;
  if (!current) throw new UpstreamError('Visual Crossing returned no current conditions');

  return {
    readingTimestamp: new Date(current.datetimeEpoch * 1000).toISOString(),
    temperature: current.temp ?? null,
    humidity: current.humidity ?? null,
    windSpeed: current.windspeed == null ? null : current.windspeed / KMH_PER_MS,
    windDirection: degreesToCompass(current.winddir ?? null),
    precipitationToday: current.precip ?? null,
    uvIndex: current.uvindex ?? null,
    pressure: current.pressure ?? null,
  };
}

interface VisualCrossingDay {
  datetime: string;
  tempmax?: number | null;
  tempmin?: number | null;
  precip?: number | null;
}

// Memory only: Visual Crossing data is never written to the database. Keyed by
// coordinates; only successful results are cached. ttlResolution 0 + a perf
// that calls Date.now() each time so expiry follows the current Date.
const historyCache = new LRUCache<string, DailyHistoryPoint[]>({
  max: HISTORY_CACHE_MAX,
  ttl: HISTORY_TTL_MS,
  ttlResolution: 0,
  perf: { now: () => Date.now() },
});

export async function fetchHistory(lat: number, lon: number): Promise<DailyHistoryPoint[]> {
  const key = `${lat},${lon}`;
  const cached = historyCache.get(key);
  if (cached) return cached;

  const url = timelineUrl(lat, lon, 'last7days', {
    include: 'days',
    elements: 'datetime,tempmax,tempmin,precip',
  });

  const body = await fetchProviderJson<{ days?: VisualCrossingDay[] }>('Visual Crossing', url);
  const history = (body.days ?? []).map((day) => ({
    date: day.datetime,
    tempMaxC: day.tempmax ?? null,
    tempMinC: day.tempmin ?? null,
    precipMm: day.precip ?? null,
  }));

  historyCache.set(key, history);
  return history;
}

// Test hook: forget cached history.
export function clearHistoryCache(): void {
  historyCache.clear();
}

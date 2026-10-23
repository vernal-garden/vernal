import { LRUCache } from 'lru-cache';
import { degreesToCompass } from '../compass';
import type { NormalizedReading, DailyHistoryPoint } from '../types';
import { UpstreamError, fetchProviderJson } from '../upstream';

export interface GeoLocation {
  lat: number;
  lon: number;
}

const GEOCODE_CACHE_MAX = 10_000;
const GEOCODE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const GEOCODE_MISS_TTL_MS = 60 * 60 * 1000;
// Nominatim's usage policy allows at most one request per second.
const NOMINATIM_INTERVAL_MS = 1000;
const NOMINATIM_MAX_WAIT_MS = 3000;
const NO_RESULTS = 'No geocoding results for the account location';

// Keyed by the account's free-text location. 'not_found' remembers a label
// Nominatim has no answer for, so it isn't looked up on every request; network
// failures are never cached. ttlResolution 0 + a perf that calls Date.now()
// each time so expiry follows the current Date.
const geocodeCache = new LRUCache<string, GeoLocation | 'not_found'>({
  max: GEOCODE_CACHE_MAX,
  ttl: GEOCODE_TTL_MS,
  ttlResolution: 0,
  perf: { now: () => Date.now() },
});

// Lookups in progress, so concurrent callers for one label share a request.
const inFlight = new Map<string, Promise<GeoLocation>>();

// When the next Nominatim request may start.
let nextSlotAt = 0;

// Off in tests (like the rate limiters) unless ENFORCE_RATE_LIMITS is set.
const limiterEnabled = (): boolean =>
  process.env.NODE_ENV !== 'test' || process.env.ENFORCE_RATE_LIMITS === 'true';

// Waits for the next Nominatim slot, or fails fast when the queue is already
// longer than NOMINATIM_MAX_WAIT_MS.
async function takeNominatimSlot(): Promise<void> {
  if (!limiterEnabled()) return;
  const now = Date.now();
  const wait = Math.max(0, nextSlotAt - now);
  if (wait > NOMINATIM_MAX_WAIT_MS) throw new UpstreamError('Nominatim busy');
  nextSlotAt = Math.max(now, nextSlotAt) + NOMINATIM_INTERVAL_MS;
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

// Origins are overridable so E2E can point the server at a dead port. Read at
// call time (not module load) so unit tests can set them per test.
function baseUrl(envVar: string, fallback: string): string {
  const value = process.env[envVar] || fallback;
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

const openMeteoBase = (): string => baseUrl('OPEN_METEO_BASE_URL', 'https://api.open-meteo.com');
const nominatimBase = (): string => baseUrl('NOMINATIM_BASE_URL', 'https://nominatim.openstreetmap.org');

async function lookup(label: string): Promise<GeoLocation> {
  await takeNominatimSlot();
  const url = `${nominatimBase()}/search?q=${encodeURIComponent(label)}&format=json&limit=1`;
  const results = await fetchProviderJson<Array<{ lat: string; lon: string }>>('Nominatim', url, {
    headers: { 'User-Agent': 'Vernal Garden App/1.0' },
  });
  const first = results[0];
  if (!first) {
    geocodeCache.set(label, 'not_found', { ttl: GEOCODE_MISS_TTL_MS });
    throw new UpstreamError(NO_RESULTS);
  }

  const location: GeoLocation = { lat: Number(first.lat), lon: Number(first.lon) };
  geocodeCache.set(label, location);
  return location;
}

export async function geocode(label: string): Promise<GeoLocation> {
  const cached = geocodeCache.get(label);
  if (cached === 'not_found') throw new UpstreamError(NO_RESULTS);
  if (cached) return cached;

  let pending = inFlight.get(label);
  if (!pending) {
    pending = lookup(label).finally(() => inFlight.delete(label));
    inFlight.set(label, pending);
  }
  return pending;
}

// Test hook: forget cached locations, lookups in progress and limiter state.
export function resetGeocoder(): void {
  geocodeCache.clear();
  inFlight.clear();
  nextSlotAt = 0;
}

interface OpenMeteoCurrent {
  time: string;
  temperature_2m: number;
  relative_humidity_2m: number;
  precipitation: number;
  surface_pressure: number;
  wind_speed_10m: number;
  wind_direction_10m: number;
  uv_index: number;
}

export async function fetchOpenMeteoCurrent(lat: number, lon: number): Promise<NormalizedReading> {
  const url =
    `${openMeteoBase()}/v1/forecast?latitude=${lat}&longitude=${lon}` +
    '&current=temperature_2m,relative_humidity_2m,precipitation,surface_pressure,wind_speed_10m,wind_direction_10m,uv_index' +
    '&temperature_unit=celsius&wind_speed_unit=ms&precipitation_unit=mm';

  const body = await fetchProviderJson<{ current: OpenMeteoCurrent }>('Open-Meteo', url);
  const current = body.current;

  return {
    readingTimestamp: current.time ?? new Date().toISOString(),
    temperature: current.temperature_2m,
    humidity: current.relative_humidity_2m,
    windSpeed: current.wind_speed_10m,
    windDirection: degreesToCompass(current.wind_direction_10m),
    precipitationToday: current.precipitation,
    uvIndex: current.uv_index,
    pressure: current.surface_pressure,
  };
}

interface OpenMeteoDaily {
  time: string[];
  temperature_2m_max: number[];
  temperature_2m_min: number[];
  precipitation_sum: number[];
}

export async function fetchOpenMeteoHistory(lat: number, lon: number): Promise<DailyHistoryPoint[]> {
  const url =
    `${openMeteoBase()}/v1/forecast?latitude=${lat}&longitude=${lon}` +
    '&daily=temperature_2m_max,temperature_2m_min,precipitation_sum' +
    '&past_days=7&forecast_days=1&temperature_unit=celsius&precipitation_unit=mm';

  const body = await fetchProviderJson<{ daily: OpenMeteoDaily }>('Open-Meteo', url);
  const daily = body.daily;

  return daily.time.map((date, i) => ({
    date,
    tempMaxC: daily.temperature_2m_max[i] ?? null,
    tempMinC: daily.temperature_2m_min[i] ?? null,
    precipMm: daily.precipitation_sum[i] ?? null,
  }));
}

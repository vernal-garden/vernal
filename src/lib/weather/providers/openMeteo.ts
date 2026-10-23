import { degreesToCompass } from '../compass';
import type { NormalizedReading, DailyHistoryPoint } from '../types';
import { UpstreamError, fetchProviderJson } from '../upstream';

export interface GeoLocation {
  lat: number;
  lon: number;
}

const geocodeCache = new Map<string, GeoLocation>();

// Origins are overridable so E2E can point the server at a dead port. Read at
// call time (not module load) so unit tests can set them per test.
function baseUrl(envVar: string, fallback: string): string {
  const value = process.env[envVar] || fallback;
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

const openMeteoBase = (): string => baseUrl('OPEN_METEO_BASE_URL', 'https://api.open-meteo.com');
const nominatimBase = (): string => baseUrl('NOMINATIM_BASE_URL', 'https://nominatim.openstreetmap.org');

export async function geocode(label: string): Promise<GeoLocation> {
  const cached = geocodeCache.get(label);
  if (cached) return cached;

  const url = `${nominatimBase()}/search?q=${encodeURIComponent(label)}&format=json&limit=1`;
  const results = await fetchProviderJson<Array<{ lat: string; lon: string }>>('Nominatim', url, {
    headers: { 'User-Agent': 'Vernal Garden App/1.0' },
  });
  const first = results[0];
  if (!first) {
    throw new UpstreamError('No geocoding results for the account location');
  }

  const location: GeoLocation = { lat: Number(first.lat), lon: Number(first.lon) };
  geocodeCache.set(label, location);
  return location;
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

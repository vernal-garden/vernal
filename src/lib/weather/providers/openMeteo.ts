import { degreesToCompass } from '../compass';
import type { NormalizedReading, DailyHistoryPoint } from '../types';

export interface GeoLocation {
  lat: number;
  lon: number;
}

const geocodeCache = new Map<string, GeoLocation>();

export async function geocode(label: string): Promise<GeoLocation> {
  const cached = geocodeCache.get(label);
  if (cached) return cached;

  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(label)}&format=json&limit=1`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Vernal Garden App/1.0' } });

  if (!res.ok) {
    throw new Error(`Nominatim geocoding request failed with status ${res.status}`);
  }

  const results = (await res.json()) as Array<{ lat: string; lon: string }>;
  const first = results[0];
  if (!first) {
    throw new Error(`No geocoding results for "${label}"`);
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
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    '&current=temperature_2m,relative_humidity_2m,precipitation,surface_pressure,wind_speed_10m,wind_direction_10m,uv_index' +
    '&temperature_unit=celsius&wind_speed_unit=ms&precipitation_unit=mm';

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Open-Meteo request failed with status ${res.status}`);
  }

  const body = (await res.json()) as { current: OpenMeteoCurrent };
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
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    '&daily=temperature_2m_max,temperature_2m_min,precipitation_sum' +
    '&past_days=7&forecast_days=1&temperature_unit=celsius&precipitation_unit=mm';

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Open-Meteo request failed with status ${res.status}`);
  }

  const body = (await res.json()) as { daily: OpenMeteoDaily };
  const daily = body.daily;

  return daily.time.map((date, i) => ({
    date,
    tempMaxC: daily.temperature_2m_max[i] ?? null,
    tempMinC: daily.temperature_2m_min[i] ?? null,
    precipMm: daily.precipitation_sum[i] ?? null,
  }));
}

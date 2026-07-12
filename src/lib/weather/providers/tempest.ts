import { degreesToCompass } from '../compass';
import type { NormalizedReading } from '../types';

interface TempestObservation {
  timestamp: number;
  air_temperature: number;
  relative_humidity: number;
  wind_avg: number;
  wind_direction: number;
  precip_accum_local_day: number;
  uv: number;
  sea_level_pressure?: number;
  station_pressure?: number;
}

export async function fetchTempestCurrent(
  accessToken: string,
  stationId: string,
): Promise<NormalizedReading> {
  const url = `https://swd.weatherflow.com/swd/rest/observations/station/${stationId}?token=${accessToken}`;
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Tempest API request failed with status ${res.status}`);
  }

  const body = (await res.json()) as { obs?: TempestObservation[] };
  const obs = body.obs?.[0];
  if (!obs) {
    throw new Error('Tempest API returned no observations');
  }

  return {
    readingTimestamp: new Date(obs.timestamp * 1000).toISOString(),
    temperature: obs.air_temperature,
    humidity: obs.relative_humidity,
    windSpeed: obs.wind_avg,
    windDirection: degreesToCompass(obs.wind_direction),
    precipitationToday: obs.precip_accum_local_day,
    uvIndex: obs.uv,
    pressure: obs.sea_level_pressure ?? obs.station_pressure ?? null,
  };
}

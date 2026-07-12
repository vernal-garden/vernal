import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchTempestCurrent } from './tempest';

function mockFetchOnce(response: Partial<Response> & { ok: boolean; json: () => Promise<unknown> }) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchTempestCurrent', () => {
  it('maps a Tempest observation onto NormalizedReading', async () => {
    mockFetchOnce({
      ok: true,
      json: async () => ({
        obs: [
          {
            timestamp: 1_700_000_000,
            air_temperature: 18.5,
            relative_humidity: 62,
            wind_avg: 3.2,
            wind_direction: 90,
            precip_accum_local_day: 1.4,
            uv: 5,
            sea_level_pressure: 1013.2,
          },
        ],
      }),
    });

    const reading = await fetchTempestCurrent('token123', 'station456');

    expect(reading).toEqual({
      readingTimestamp: new Date(1_700_000_000 * 1000).toISOString(),
      temperature: 18.5,
      humidity: 62,
      windSpeed: 3.2,
      windDirection: 'E',
      precipitationToday: 1.4,
      uvIndex: 5,
      pressure: 1013.2,
    });
  });

  it('calls the Tempest REST endpoint with the token and station id', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ obs: [{ timestamp: 1, air_temperature: 1, relative_humidity: 1, wind_avg: 1, wind_direction: 0, precip_accum_local_day: 0, uv: 0, sea_level_pressure: 1000 }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await fetchTempestCurrent('my-token', 'station-99');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://swd.weatherflow.com/swd/rest/observations/station/station-99?token=my-token',
    );
  });

  it('falls back to station_pressure when sea_level_pressure is absent', async () => {
    mockFetchOnce({
      ok: true,
      json: async () => ({
        obs: [
          {
            timestamp: 1_700_000_000,
            air_temperature: 10,
            relative_humidity: 50,
            wind_avg: 1,
            wind_direction: 0,
            precip_accum_local_day: 0,
            uv: 0,
            station_pressure: 990.5,
          },
        ],
      }),
    });

    const reading = await fetchTempestCurrent('token', 'station');
    expect(reading.pressure).toBe(990.5);
  });

  it('throws when the response is not OK', async () => {
    mockFetchOnce({ ok: false, json: async () => ({}) });
    await expect(fetchTempestCurrent('token', 'station')).rejects.toThrow();
  });

  it('throws when obs[] is empty', async () => {
    mockFetchOnce({ ok: true, json: async () => ({ obs: [] }) });
    await expect(fetchTempestCurrent('token', 'station')).rejects.toThrow();
  });
});

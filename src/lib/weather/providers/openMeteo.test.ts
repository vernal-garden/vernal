import { describe, it, expect, vi, afterEach } from 'vitest';
import { geocode, fetchOpenMeteoCurrent, fetchOpenMeteoHistory } from './openMeteo';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('geocode', () => {
  it('geocodes a label via Nominatim with a User-Agent header', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ lat: '45.5', lon: '-122.6' }],
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await geocode('Portland, OR — geocode-header-test');

    expect(result).toEqual({ lat: 45.5, lon: -122.6 });
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toContain('https://nominatim.openstreetmap.org/search?q=');
    expect(url).toContain('format=json&limit=1');
    expect(options.headers['User-Agent']).toBe('Vernal Garden App/1.0');
  });

  it('caches results in-memory per label, skipping a second fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ lat: '10', lon: '20' }],
    });
    vi.stubGlobal('fetch', fetchMock);

    const label = 'Cache Test City';
    const first = await geocode(label);
    const second = await geocode(label);

    expect(first).toEqual({ lat: 10, lon: 20 });
    expect(second).toEqual({ lat: 10, lon: 20 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws when there are no results', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => [] }));
    await expect(geocode('Nowhere Land — empty-results-test')).rejects.toThrow();
  });
});

describe('fetchOpenMeteoCurrent', () => {
  it('maps Open-Meteo current conditions onto NormalizedReading', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          current: {
            time: '2026-07-11T12:00',
            temperature_2m: 22.1,
            relative_humidity_2m: 55,
            precipitation: 0.2,
            surface_pressure: 1005.3,
            wind_speed_10m: 4.1,
            wind_direction_10m: 180,
            uv_index: 6,
          },
        }),
      }),
    );

    const reading = await fetchOpenMeteoCurrent(45.5, -122.6);

    expect(reading).toEqual({
      readingTimestamp: '2026-07-11T12:00',
      temperature: 22.1,
      humidity: 55,
      windSpeed: 4.1,
      windDirection: 'S',
      precipitationToday: 0.2,
      uvIndex: 6,
      pressure: 1005.3,
    });
  });
});

describe('fetchOpenMeteoHistory', () => {
  it('zips daily arrays into DailyHistoryPoint[]', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          daily: {
            time: ['2026-07-04', '2026-07-05'],
            temperature_2m_max: [25.0, 26.5],
            temperature_2m_min: [14.0, 15.0],
            precipitation_sum: [0, 3.2],
          },
        }),
      }),
    );

    const history = await fetchOpenMeteoHistory(45.5, -122.6);

    expect(history).toEqual([
      { date: '2026-07-04', tempMaxC: 25.0, tempMinC: 14.0, precipMm: 0 },
      { date: '2026-07-05', tempMaxC: 26.5, tempMinC: 15.0, precipMm: 3.2 },
    ]);
  });
});

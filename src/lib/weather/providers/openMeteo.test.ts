import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { geocode, fetchOpenMeteoCurrent, fetchOpenMeteoHistory, resetGeocoder } from './openMeteo';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  resetGeocoder();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  process.env = { ...ORIGINAL_ENV };
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

describe('geocode caching and rate limiting', () => {
  function geocodeFetch(body: unknown) {
    return vi.fn().mockResolvedValue({ ok: true, json: async () => body });
  }

  it('remembers a label with no results for an hour', async () => {
    vi.useFakeTimers();
    const fetchMock = geocodeFetch([]);
    vi.stubGlobal('fetch', fetchMock);

    await expect(geocode('Nowhere')).rejects.toThrow('No geocoding results for the account location');
    await expect(geocode('Nowhere')).rejects.toThrow('No geocoding results for the account location');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60 * 60 * 1000 + 1);
    await expect(geocode('Nowhere')).rejects.toThrow('No geocoding results for the account location');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not cache a network failure', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce({ ok: true, json: async () => [{ lat: '1', lon: '2' }] });
    vi.stubGlobal('fetch', fetchMock);

    await expect(geocode('Flaky')).rejects.toThrow('Nominatim unreachable');
    await expect(geocode('Flaky')).resolves.toEqual({ lat: 1, lon: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('shares one lookup between concurrent callers for the same label', async () => {
    const fetchMock = geocodeFetch([{ lat: '3', lon: '4' }]);
    vi.stubGlobal('fetch', fetchMock);

    const [a, b] = await Promise.all([geocode('Same Place'), geocode('Same Place')]);

    expect(a).toEqual({ lat: 3, lon: 4 });
    expect(b).toEqual({ lat: 3, lon: 4 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('spaces Nominatim requests 1 s apart when limits are enforced', async () => {
    process.env.ENFORCE_RATE_LIMITS = 'true';
    vi.useFakeTimers();
    const fetchMock = geocodeFetch([{ lat: '1', lon: '1' }]);
    vi.stubGlobal('fetch', fetchMock);

    const both = Promise.all([geocode('Place A'), geocode('Place B')]);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await both;
  });

  it('rejects as busy instead of queueing more than 3 s', async () => {
    process.env.ENFORCE_RATE_LIMITS = 'true';
    vi.useFakeTimers();
    const fetchMock = geocodeFetch([{ lat: '1', lon: '1' }]);
    vi.stubGlobal('fetch', fetchMock);

    const queued = ['Q1', 'Q2', 'Q3', 'Q4'].map((label) => geocode(label));
    await expect(geocode('Q5')).rejects.toThrow('Nominatim busy');

    await vi.advanceTimersByTimeAsync(3000);
    await Promise.all(queued);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('does not space requests in tests unless limits are enforced', async () => {
    const fetchMock = geocodeFetch([{ lat: '1', lon: '1' }]);
    vi.stubGlobal('fetch', fetchMock);

    await Promise.all(['T1', 'T2', 'T3', 'T4', 'T5', 'T6'].map((label) => geocode(label)));
    expect(fetchMock).toHaveBeenCalledTimes(6);
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

describe('configurable origins', () => {
  const currentQuery =
    '/v1/forecast?latitude=45.5&longitude=-122.6' +
    '&current=temperature_2m,relative_humidity_2m,precipitation,surface_pressure,wind_speed_10m,wind_direction_10m,uv_index' +
    '&temperature_unit=celsius&wind_speed_unit=ms&precipitation_unit=mm';
  const historyQuery =
    '/v1/forecast?latitude=45.5&longitude=-122.6' +
    '&daily=temperature_2m_max,temperature_2m_min,precipitation_sum' +
    '&past_days=7&forecast_days=1&temperature_unit=celsius&precipitation_unit=mm';

  function stubFetch(body: unknown) {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => body });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }
  const currentBody = {
    current: {
      time: '2026-07-11T12:00', temperature_2m: 20, relative_humidity_2m: 50, precipitation: 0,
      surface_pressure: 1000, wind_speed_10m: 1, wind_direction_10m: 0, uv_index: 1,
    },
  };
  const historyBody = {
    daily: { time: [], temperature_2m_max: [], temperature_2m_min: [], precipitation_sum: [] },
  };

  it('geocode uses NOMINATIM_BASE_URL', async () => {
    process.env.NOMINATIM_BASE_URL = 'http://example.test';
    const fetchMock = stubFetch([{ lat: '1', lon: '2' }]);

    await geocode('Origin City — nominatim-env-test');

    expect(fetchMock.mock.calls[0][0]).toBe(
      `http://example.test/search?q=${encodeURIComponent('Origin City — nominatim-env-test')}&format=json&limit=1`,
    );
  });

  it('geocode strips a trailing slash from NOMINATIM_BASE_URL', async () => {
    process.env.NOMINATIM_BASE_URL = 'http://example.test/';
    const fetchMock = stubFetch([{ lat: '1', lon: '2' }]);

    await geocode('Origin City — nominatim-slash-test');

    expect(fetchMock.mock.calls[0][0]).toMatch(/^http:\/\/example\.test\/search\?q=/);
  });

  it('fetchOpenMeteoCurrent uses OPEN_METEO_BASE_URL', async () => {
    process.env.OPEN_METEO_BASE_URL = 'http://example.test';
    const fetchMock = stubFetch(currentBody);

    await fetchOpenMeteoCurrent(45.5, -122.6);

    expect(fetchMock.mock.calls[0][0]).toBe(`http://example.test${currentQuery}`);
  });

  it('fetchOpenMeteoCurrent strips a trailing slash from OPEN_METEO_BASE_URL', async () => {
    process.env.OPEN_METEO_BASE_URL = 'http://example.test/';
    const fetchMock = stubFetch(currentBody);

    await fetchOpenMeteoCurrent(45.5, -122.6);

    expect(fetchMock.mock.calls[0][0]).toBe(`http://example.test${currentQuery}`);
  });

  it('fetchOpenMeteoHistory uses OPEN_METEO_BASE_URL', async () => {
    process.env.OPEN_METEO_BASE_URL = 'http://example.test';
    const fetchMock = stubFetch(historyBody);

    await fetchOpenMeteoHistory(45.5, -122.6);

    expect(fetchMock.mock.calls[0][0]).toBe(`http://example.test${historyQuery}`);
  });

  it('fetchOpenMeteoHistory strips a trailing slash from OPEN_METEO_BASE_URL', async () => {
    process.env.OPEN_METEO_BASE_URL = 'http://example.test/';
    const fetchMock = stubFetch(historyBody);

    await fetchOpenMeteoHistory(45.5, -122.6);

    expect(fetchMock.mock.calls[0][0]).toBe(`http://example.test${historyQuery}`);
  });

  it('defaults to the public origins when neither variable is set', async () => {
    delete process.env.OPEN_METEO_BASE_URL;
    delete process.env.NOMINATIM_BASE_URL;
    const fetchMock = stubFetch(currentBody);
    await fetchOpenMeteoCurrent(45.5, -122.6);
    expect(fetchMock.mock.calls[0][0]).toBe(`https://api.open-meteo.com${currentQuery}`);

    const historyMock = stubFetch(historyBody);
    await fetchOpenMeteoHistory(45.5, -122.6);
    expect(historyMock.mock.calls[0][0]).toBe(`https://api.open-meteo.com${historyQuery}`);
  });
});

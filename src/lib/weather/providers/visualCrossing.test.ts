import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { fetchCurrent, fetchHistory, clearHistoryCache } from './visualCrossing';

const ORIGINAL_ENV = { ...process.env };
const KEY = 'test-secret-key-123';

beforeEach(() => {
  process.env.VISUAL_CROSSING_API_KEY = KEY;
  delete process.env.VISUAL_CROSSING_BASE_URL;
  clearHistoryCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...ORIGINAL_ENV };
});

function stubFetch(body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => body });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const currentBody = {
  currentConditions: {
    datetimeEpoch: 1783771200,
    temp: 22.1,
    humidity: 55,
    precip: 0.2,
    pressure: 1005.3,
    windspeed: 36,
    winddir: 180,
    uvindex: 6,
  },
};

describe('fetchCurrent', () => {
  it('builds the timeline URL for today with the current-conditions params', async () => {
    const fetchMock = stubFetch(currentBody);

    await fetchCurrent(45.5, -122.6);

    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.origin).toBe('https://weather.visualcrossing.com');
    expect(url.pathname).toBe('/VisualCrossingWebServices/rest/services/timeline/45.5,-122.6/today');
    expect(url.searchParams.get('unitGroup')).toBe('metric');
    expect(url.searchParams.get('contentType')).toBe('json');
    expect(url.searchParams.get('key')).toBe(KEY);
    expect(url.searchParams.get('include')).toBe('current');
    expect(url.searchParams.get('elements')).toBe(
      'datetimeEpoch,temp,humidity,precip,pressure,windspeed,winddir,uvindex',
    );
  });

  it('maps every field and converts km/h to m/s', async () => {
    stubFetch(currentBody);

    const reading = await fetchCurrent(45.5, -122.6);

    expect(reading).toEqual({
      readingTimestamp: new Date(1783771200 * 1000).toISOString(),
      temperature: 22.1,
      humidity: 55,
      windSpeed: 10,
      windDirection: 'S',
      precipitationToday: 0.2,
      uvIndex: 6,
      pressure: 1005.3,
    });
  });

  it('passes missing values through as null', async () => {
    stubFetch({
      currentConditions: {
        datetimeEpoch: 1783771200,
        temp: null,
        humidity: null,
        precip: null,
        pressure: null,
        windspeed: null,
        winddir: null,
        uvindex: null,
      },
    });

    const reading = await fetchCurrent(45.5, -122.6);

    expect(reading).toMatchObject({
      temperature: null,
      humidity: null,
      windSpeed: null,
      windDirection: null,
      precipitationToday: null,
      uvIndex: null,
      pressure: null,
    });
  });

  it('throws when there are no current conditions', async () => {
    stubFetch({});
    await expect(fetchCurrent(45.5, -122.6)).rejects.toThrow(
      'Visual Crossing returned no current conditions',
    );
  });
});

describe('fetchHistory', () => {
  const historyBody = {
    days: [
      { datetime: '2026-07-04', tempmax: 25, tempmin: 14, precip: 0 },
      { datetime: '2026-07-05', tempmax: 26.5, tempmin: null, precip: 3.2 },
    ],
  };

  it('maps days[] and requests last7days', async () => {
    const fetchMock = stubFetch(historyBody);

    const history = await fetchHistory(45.5, -122.6);

    expect(history).toEqual([
      { date: '2026-07-04', tempMaxC: 25, tempMinC: 14, precipMm: 0 },
      { date: '2026-07-05', tempMaxC: 26.5, tempMinC: null, precipMm: 3.2 },
    ]);
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.pathname).toBe('/VisualCrossingWebServices/rest/services/timeline/45.5,-122.6/last7days');
    expect(url.searchParams.get('include')).toBe('days');
    expect(url.searchParams.get('elements')).toBe('datetime,tempmax,tempmin,precip');
  });

  it('returns an empty list when days is missing', async () => {
    stubFetch({});
    await expect(fetchHistory(1, 2)).resolves.toEqual([]);
  });

  it('serves a second call from memory within the TTL', async () => {
    const fetchMock = stubFetch(historyBody);

    await fetchHistory(45.5, -122.6);
    await fetchHistory(45.5, -122.6);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fetches again after the cache is cleared', async () => {
    const fetchMock = stubFetch(historyBody);

    await fetchHistory(45.5, -122.6);
    clearHistoryCache();
    await fetchHistory(45.5, -122.6);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('misses the cache for a different location', async () => {
    const fetchMock = stubFetch(historyBody);

    await fetchHistory(45.5, -122.6);
    await fetchHistory(40, -100);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('expires cached history after the TTL', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = stubFetch(historyBody);

      await fetchHistory(45.5, -122.6);
      vi.advanceTimersByTime(60 * 60 * 1000 + 1);
      await fetchHistory(45.5, -122.6);

      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not cache a failure', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => historyBody });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchHistory(45.5, -122.6)).rejects.toThrow('status 500');
    await expect(fetchHistory(45.5, -122.6)).resolves.toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('errors and configuration', () => {
  it('reports a non-OK status without leaking the key or host', async () => {
    process.env.VISUAL_CROSSING_BASE_URL = 'http://vc-custom-host.test';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }));

    const error = await fetchCurrent(45.5, -122.6).catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('status 401');
    expect(message).not.toContain(KEY);
    expect(message).not.toContain('visualcrossing.com');
    expect(message).not.toContain('vc-custom-host');
  });

  it('fails without calling fetch when the API key is missing', async () => {
    delete process.env.VISUAL_CROSSING_API_KEY;
    const fetchMock = stubFetch(currentBody);

    await expect(fetchCurrent(45.5, -122.6)).rejects.toThrow('Visual Crossing is not configured');
    await expect(fetchHistory(45.5, -122.6)).rejects.toThrow('Visual Crossing is not configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('honours VISUAL_CROSSING_BASE_URL and trims a trailing slash', async () => {
    process.env.VISUAL_CROSSING_BASE_URL = 'http://example.test/';
    const fetchMock = stubFetch(currentBody);

    await fetchCurrent(45.5, -122.6);

    expect(fetchMock.mock.calls[0][0]).toMatch(
      /^http:\/\/example\.test\/VisualCrossingWebServices\/rest\/services\/timeline\/45\.5,-122\.6\/today\?/,
    );
  });
});

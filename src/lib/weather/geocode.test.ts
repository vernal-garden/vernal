import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { geocode, resetGeocoder } from './geocode';

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

describe('configurable origin', () => {
  function stubFetch(body: unknown) {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => body });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

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
});

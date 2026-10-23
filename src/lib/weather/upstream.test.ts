import { describe, it, expect, vi, afterEach } from 'vitest';
import { UpstreamError, UPSTREAM_TIMEOUT_MS, fetchProviderJson, logWeatherFailure } from './upstream';
import { logger } from '../logger';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('fetchProviderJson', () => {
  it('turns a network failure into UpstreamError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    await expect(fetchProviderJson('Open-Meteo', 'https://x')).rejects.toThrow(UpstreamError);
  });

  it('turns a non-OK response into UpstreamError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 502 })));
    await expect(fetchProviderJson('Open-Meteo', 'https://x')).rejects.toThrow(
      'Open-Meteo request failed with status 502',
    );
  });

  it('turns an unreadable body into UpstreamError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>', { status: 200 })));
    await expect(fetchProviderJson('Open-Meteo', 'https://x')).rejects.toThrow(UpstreamError);
  });

  // A fetch that never answers; it rejects only when its signal aborts.
  function hangingFetch() {
    return vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
        }),
    );
  }

  it('gives up with "timed out" after UPSTREAM_TIMEOUT_MS', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', hangingFetch());

    const result = fetchProviderJson('Open-Meteo', 'https://x');
    const assertion = expect(result).rejects.toThrow('Open-Meteo timed out');
    await vi.advanceTimersByTimeAsync(UPSTREAM_TIMEOUT_MS);
    await assertion;
  });

  it('does not time out early', async () => {
    vi.useFakeTimers();
    const fetchMock = hangingFetch();
    vi.stubGlobal('fetch', fetchMock);

    let settled = false;
    fetchProviderJson('Open-Meteo', 'https://x').catch(() => {}).finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(UPSTREAM_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
  });

  it('times out while reading a slow body', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => ({
        ok: true,
        status: 200,
        json: () =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
          }),
      })),
    );

    const result = fetchProviderJson('Open-Meteo', 'https://x');
    const assertion = expect(result).rejects.toThrow('Open-Meteo timed out');
    await vi.advanceTimersByTimeAsync(UPSTREAM_TIMEOUT_MS);
    await assertion;
  });

  it('still honours a signal the caller passes, reported as unreachable', async () => {
    vi.stubGlobal('fetch', hangingFetch());
    const controller = new AbortController();

    const result = fetchProviderJson('Open-Meteo', 'https://x', { signal: controller.signal });
    controller.abort();
    await expect(result).rejects.toThrow('Open-Meteo unreachable');
  });

  it('passes the caller init through alongside the signal', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('[]', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchProviderJson('Nominatim', 'https://x', { headers: { 'User-Agent': 'UA' } });

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers).toEqual({ 'User-Agent': 'UA' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('logWeatherFailure', () => {
  it('warns for a provider failure and reports anything else', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {});

    logWeatherFailure('GET /weather/current failed', new UpstreamError('outage'));
    expect(warn).toHaveBeenCalledWith('GET /weather/current failed', { errMsg: 'outage' });
    expect(error).not.toHaveBeenCalled();

    const dbErr = new Error('db down');
    logWeatherFailure('GET /weather/current failed', dbErr);
    expect(error).toHaveBeenCalledWith('GET /weather/current failed', dbErr);
  });
});

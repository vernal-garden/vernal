import { describe, it, expect, vi, afterEach } from 'vitest';
import { UpstreamError, fetchProviderJson, logWeatherFailure } from './upstream';
import { logger } from '../logger';

afterEach(() => {
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

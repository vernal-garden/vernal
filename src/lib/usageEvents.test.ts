import { describe, it, expect, vi, afterEach } from 'vitest';
import { db } from './db';
import { logger } from './logger';
import { recordUsageEvent } from './usageEvents';

describe('recordUsageEvent', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves and logs a warning when the insert fails', async () => {
    vi.spyOn(db, 'query').mockRejectedValueOnce(new Error('connection lost') as never);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    await expect(
      recordUsageEvent('weather_station_pull', '00000000-0000-0000-0000-000000000000', null),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });
});

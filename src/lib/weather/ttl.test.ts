import { describe, it, expect } from 'vitest';
import { getTtlMs, PROVIDER_TTL_MS } from './ttl';

describe('getTtlMs', () => {
  it('returns the pws_tempest TTL (10 minutes)', () => {
    expect(getTtlMs('pws_tempest')).toBe(10 * 60_000);
  });

  it('returns the public_weather TTL (15 minutes)', () => {
    expect(getTtlMs('public_weather')).toBe(15 * 60_000);
  });

  it('defaults unknown providers to 15 minutes', () => {
    expect(getTtlMs('pws_ambient')).toBe(15 * 60_000);
  });

  it('exposes the raw TTL map', () => {
    expect(PROVIDER_TTL_MS.pws_tempest).toBe(10 * 60_000);
    expect(PROVIDER_TTL_MS.public_weather).toBe(15 * 60_000);
  });
});

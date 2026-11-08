import { describe, it, expect, afterEach } from 'vitest';
import { getServerConfig, setServerConfigForTests } from './serverConfig';
import { effectiveTier } from './tier';

const original = getServerConfig();
afterEach(() => setServerConfigForTests(original));

describe('effectiveTier', () => {
  it('returns the stored tier when billing is on', () => {
    setServerConfigForTests({ ...original, billing: 'stripe' });
    expect(effectiveTier('free')).toBe('free');
    expect(effectiveTier('supporter')).toBe('supporter');
  });

  it('returns supporter for everyone when billing is off', () => {
    setServerConfigForTests({ ...original, billing: 'off' });
    expect(effectiveTier('free')).toBe('supporter');
    expect(effectiveTier('supporter')).toBe('supporter');
  });
});

describe('effectiveTier with beta access', () => {
  it('grants supporter to a beta participant when billing is on', () => {
    setServerConfigForTests({ ...original, billing: 'stripe' });
    expect(effectiveTier('free', true)).toBe('supporter');
    expect(effectiveTier('free', false)).toBe('free');
    expect(effectiveTier('free')).toBe('free');
  });

  it('is supporter whatever the beta state when billing is off', () => {
    setServerConfigForTests({ ...original, billing: 'off' });
    expect(effectiveTier('free', false)).toBe('supporter');
    expect(effectiveTier('free', true)).toBe('supporter');
  });
});

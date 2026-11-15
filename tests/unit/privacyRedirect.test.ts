import { describe, it, expect } from 'vitest';
import { PRIVACY_URL, PRIVACY_V22_AT, privacyRedirectTarget } from '../../client/src/lib/privacyRedirect';

describe('privacyRedirectTarget', () => {
  it('returns null one millisecond before the switch', () => {
    expect(privacyRedirectTarget(PRIVACY_V22_AT - 1)).toBeNull();
  });

  it('returns the website URL at the switch', () => {
    expect(privacyRedirectTarget(PRIVACY_V22_AT)).toBe(PRIVACY_URL);
  });

  it('returns the website URL one hour after the switch', () => {
    expect(privacyRedirectTarget(PRIVACY_V22_AT + 60 * 60 * 1000)).toBe(PRIVACY_URL);
  });

  it('switches at midnight Pacific on 2026-11-16', () => {
    expect(PRIVACY_V22_AT).toBe(Date.parse('2026-11-16T08:00:00Z'));
  });
});

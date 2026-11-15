// Privacy policy v2.2 moves to the website at this time (midnight Pacific, 2026-11-16).
export const PRIVACY_URL = 'https://vernal.garden/privacy';
export const PRIVACY_V22_AT = Date.parse('2026-11-16T00:00:00-08:00');

export function privacyRedirectTarget(nowMs: number): string | null {
  return nowMs >= PRIVACY_V22_AT ? PRIVACY_URL : null;
}

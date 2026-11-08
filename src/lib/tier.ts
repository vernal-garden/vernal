import { getServerConfig } from './serverConfig';

// The tier a request should act on. A server with billing off has nobody to
// pay, so every account gets every feature. A beta participant (see
// betaAccessApplies in beta.ts) gets Supporter access while the switch is on.
// The stored tier is never changed.
export function effectiveTier(
  stored: 'free' | 'supporter',
  betaAccess = false,
): 'free' | 'supporter' {
  if (getServerConfig().billing === 'off') return 'supporter';
  return betaAccess ? 'supporter' : stored;
}

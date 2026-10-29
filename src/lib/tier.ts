import { getServerConfig } from './serverConfig';

// The tier a request should act on. A server with billing off has nobody to
// pay, so every account gets every feature. The stored tier is never changed.
export function effectiveTier(stored: 'free' | 'supporter'): 'free' | 'supporter' {
  return getServerConfig().billing === 'off' ? 'supporter' : stored;
}

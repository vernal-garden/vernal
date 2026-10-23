import { logger } from '../logger';

// A weather or geocoding provider failed or had no answer. Logged as a warning:
// an outage or an unknown place name is not our bug, so it stays out of Sentry.
export class UpstreamError extends Error {
  name = 'UpstreamError';
}

// Longest a provider request may take, response body included.
export const UPSTREAM_TIMEOUT_MS = 5000;

// fetch plus JSON parse for a provider. Network failures, timeouts, non-OK
// responses and unparseable bodies all become UpstreamError. The timer is a
// plain setTimeout (not AbortSignal.timeout) so tests can drive it with fake
// timers.
export async function fetchProviderJson<T>(provider: string, url: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, UPSTREAM_TIMEOUT_MS);
  const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;

  try {
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal });
    } catch (err) {
      throw new UpstreamError(timedOut ? `${provider} timed out` : `${provider} unreachable`, { cause: err });
    }
    if (!res.ok) {
      throw new UpstreamError(`${provider} request failed with status ${res.status}`);
    }
    try {
      return (await res.json()) as T;
    } catch (err) {
      throw new UpstreamError(
        timedOut ? `${provider} timed out` : `${provider} returned an unreadable response`,
        { cause: err },
      );
    }
  } finally {
    clearTimeout(timer);
  }
}

// A provider failure is a warning; anything else (DB, decrypt) is our bug and
// goes to Sentry.
export function logWeatherFailure(message: string, err: unknown): void {
  if (err instanceof UpstreamError) logger.warn(message, { errMsg: err.message });
  else logger.error(message, err);
}

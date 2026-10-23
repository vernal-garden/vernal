import { logger } from '../logger';

// A weather or geocoding provider failed or had no answer. Logged as a warning:
// an outage or an unknown place name is not our bug, so it stays out of Sentry.
export class UpstreamError extends Error {
  name = 'UpstreamError';
}

// fetch plus JSON parse for a provider. Network failures, non-OK responses and
// unparseable bodies all become UpstreamError.
export async function fetchProviderJson<T>(provider: string, url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await (init ? fetch(url, init) : fetch(url));
  } catch (err) {
    throw new UpstreamError(`${provider} unreachable`, { cause: err });
  }
  if (!res.ok) {
    throw new UpstreamError(`${provider} request failed with status ${res.status}`);
  }
  try {
    return (await res.json()) as T;
  } catch (err) {
    throw new UpstreamError(`${provider} returned an unreadable response`, { cause: err });
  }
}

// A provider failure is a warning; anything else (DB, decrypt) is our bug and
// goes to Sentry.
export function logWeatherFailure(message: string, err: unknown): void {
  if (err instanceof UpstreamError) logger.warn(message, { errMsg: err.message });
  else logger.error(message, err);
}

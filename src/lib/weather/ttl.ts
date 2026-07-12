export const PROVIDER_TTL_MS: Record<string, number> = {
  pws_tempest: 10 * 60_000,
  public_weather: 15 * 60_000,
};

const DEFAULT_TTL_MS = 15 * 60_000;

export function getTtlMs(provider: string): number {
  return PROVIDER_TTL_MS[provider] ?? DEFAULT_TTL_MS;
}

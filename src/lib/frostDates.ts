// Zone-based frost date estimates for the Planting Guide (Phase 45). Used only
// when the account has no frost dates of its own.

import { applySeasonYear, type FrostContext } from './plantingSchedule';

export type FrostBasis = 'noaa' | 'rough';

export interface FrostEstimate {
  lastSpringFrost: string | null;
  firstFallFrost: string | null;
  frostFree: boolean;
  parsed: boolean;
  basis: FrostBasis | null;
}

// Spring dates for zones 3-9 are the median, across NOAA stations in each USDA
// 2023 zone, of the station's 50% last 32°F date (Research Analyst's
// zone_spread_summary.csv; Vernal SME hort note, Revision 1). Zones 1-2 and
// every fall date are still the morningchores.com midpoints (read 2026-10-09),
// which are not a source; the app labels those zones a rough estimate.
// Values are MM-DD: [last spring, first fall].
const ZONE_FROST_DATES: Record<number, [string, string]> = {
  1: ['05-28', '08-28'],
  2: ['05-18', '09-04'],
  3: ['05-18', '09-11'],
  4: ['05-13', '09-29'],
  5: ['05-04', '10-17'],
  6: ['04-24', '10-24'],
  7: ['04-07', '11-06'],
  8: ['03-20', '11-17'],
  9: ['02-12', '12-04'],
};

const LEADING_INT_RE = /^\s*(\d+)/;

export function estimateFrostDates(zone: string, season: number): FrostEstimate {
  const match = LEADING_INT_RE.exec(zone);
  const n = match ? parseInt(match[1], 10) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 13) {
    return { lastSpringFrost: null, firstFallFrost: null, frostFree: false, parsed: false, basis: null };
  }
  if (n >= 10) {
    return { lastSpringFrost: null, firstFallFrost: null, frostFree: true, parsed: true, basis: null };
  }
  const [spring, fall] = ZONE_FROST_DATES[n];
  return {
    lastSpringFrost: `${season}-${spring}`,
    firstFallFrost: `${season}-${fall}`,
    frostFree: false,
    parsed: true,
    basis: n >= 3 ? 'noaa' : 'rough',
  };
}

// The frost dates a garden's windows are computed from for a season: the
// account's own dates (moved onto the season's year) when it has a last spring
// frost date, otherwise the garden zone's estimate.
export function resolveFrostContext(
  accountFrost: { last: string; first: string | null } | null,
  zone: string,
  season: number,
): FrostContext & { firstFallFrost: string | null; frostBasis: FrostBasis | null } {
  if (accountFrost) {
    return {
      lastSpringFrost: applySeasonYear(accountFrost.last, season),
      firstFallFrost: accountFrost.first ? applySeasonYear(accountFrost.first, season) : null,
      frostSource: 'account_frost',
      frostFree: false,
      frostBasis: null,
    };
  }
  const est = estimateFrostDates(zone, season);
  return {
    lastSpringFrost: est.lastSpringFrost,
    firstFallFrost: est.firstFallFrost,
    frostSource: est.parsed && !est.frostFree ? 'zone_estimate' : null,
    frostFree: est.frostFree,
    frostBasis: est.basis,
  };
}

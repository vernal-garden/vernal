// Season helpers. A season is the calendar year (spec Q35); change that rule
// here only.

const SEASON_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
});

// en-CA formats as YYYY-MM-DD.
const DATE_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

// The season a YYYY-MM-DD calendar date belongs to.
export function seasonOf(dateKey: string): number {
  return Number(dateKey.slice(0, 4));
}

// The current season is the calendar year in America/Los_Angeles.
export function currentSeason(now: Date = new Date()): number {
  return Number(SEASON_FORMAT.format(now));
}

// Today's calendar date (YYYY-MM-DD) in America/Los_Angeles.
export function todayPacific(now: Date = new Date()): string {
  return DATE_FORMAT.format(now);
}

// The season after the current one: where planned plantings go.
export function nextSeason(now: Date = new Date()): number {
  return currentSeason(now) + 1;
}

// Seasons up to and including next season accept new plantings; earlier
// seasons that are over still do, later ones do not.
export function isWritableSeason(season: number, now: Date = new Date()): boolean {
  return season <= nextSeason(now);
}

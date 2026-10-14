// Season helpers. A season is the calendar year (spec Q35); change that rule
// here only.

const SEASON_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
});

// The season a YYYY-MM-DD calendar date belongs to.
export function seasonOf(dateKey: string): number {
  return Number(dateKey.slice(0, 4));
}

// The current season is the calendar year in America/Los_Angeles.
export function currentSeason(now: Date = new Date()): number {
  return Number(SEASON_FORMAT.format(now));
}

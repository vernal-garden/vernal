// Sowing-window math for the Planting Guide (Phase 45). Pure functions over
// plain values: no DB access and no clock reads — callers pass the season in.
// Dates cross the boundary as YYYY-MM-DD strings; internally they are handled
// as UTC midnights so no local timezone can shift a calendar date.

export type WindowSource = 'custom' | 'account_frost' | 'zone_estimate';

export type Window = { start: string; end: string; source: WindowSource } | null;

export interface Timing {
  weeksToTransplant: number | null;
  frostTolerance: string | null;
  maturityDaysMin: number | null;
  maturityDaysMax: number | null;
}

export interface Overrides {
  indoorStart: string | null;
  transplant: string | null;
  directSow: string | null;
}

export interface FrostContext {
  lastSpringFrost: string | null;
  frostSource: 'account_frost' | 'zone_estimate' | null;
  frostFree: boolean;
}

export type MissingReason = null | 'no_timing_data' | 'no_frost_date' | 'frost_free';

export interface ComputedWindows {
  indoorStart: Window;
  transplant: Window;
  directSow: Window;
  harvest: Window;
  missingReason: MissingReason;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function toUtcMs(date: string): number {
  const m = ISO_DATE_RE.exec(date);
  if (!m) throw new Error(`Invalid date: ${date}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function fromUtcMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// True for a real calendar date in YYYY-MM-DD form ('2026-02-30' is rejected).
export function isIsoDate(v: unknown): v is string {
  if (typeof v !== 'string' || !ISO_DATE_RE.test(v)) return false;
  return fromUtcMs(toUtcMs(v)) === v;
}

export function addDays(date: string, days: number): string {
  return fromUtcMs(toUtcMs(date) + days * DAY_MS);
}

// Moves a date's month-day onto the given year. Feb 29 in a non-leap year
// rolls forward to Mar 1.
export function applySeasonYear(date: string, season: number): string {
  const m = ISO_DATE_RE.exec(date);
  if (!m) throw new Error(`Invalid date: ${date}`);
  return fromUtcMs(Date.UTC(season, Number(m[2]) - 1, Number(m[3])));
}

function span(anchor: string, fromDays: number, toDays: number, source: WindowSource): Window {
  return { start: addDays(anchor, fromDays), end: addDays(anchor, toDays), source };
}

function customWindow(override: string, season: number): Window {
  const d = applySeasonYear(override, season);
  return { start: d, end: d, source: 'custom' };
}

export function computeWindows(
  timing: Timing,
  overrides: Overrides,
  frost: FrostContext,
  season: number,
): ComputedWindows {
  const hasTimingData =
    timing.weeksToTransplant !== null ||
    timing.frostTolerance !== null ||
    timing.maturityDaysMin !== null;
  const tolerance =
    timing.frostTolerance === 'light' || timing.frostTolerance === 'hard'
      ? timing.frostTolerance
      : 'none';
  const transplants = timing.weeksToTransplant !== null;

  const L = frost.lastSpringFrost;
  // Derived windows need both timing data and a frost date; the source is
  // whatever produced the frost date.
  const canDerive = hasTimingData && L !== null && frost.frostSource !== null;
  const source = frost.frostSource as WindowSource;

  let indoorStart: Window = null;
  let transplant: Window = null;
  let directSow: Window = null;

  if (canDerive && transplants) {
    const start = addDays(L, -(timing.weeksToTransplant as number) * 7 - 7);
    indoorStart = span(start, 0, 14, source);
    transplant =
      tolerance === 'hard' ? span(L, -21, 0, source)
      : tolerance === 'light' ? span(L, -7, 7, source)
      : span(L, 7, 21, source);
  }
  if (canDerive && !transplants) {
    directSow =
      tolerance === 'hard' ? span(L, -42, -14, source)
      : tolerance === 'light' ? span(L, -14, 14, source)
      : span(L, 7, 28, source);
  }

  // A date the user set always shows, even where no window would be derived.
  if (overrides.indoorStart) indoorStart = customWindow(overrides.indoorStart, season);
  if (overrides.transplant) transplant = customWindow(overrides.transplant, season);
  if (overrides.directSow) directSow = customWindow(overrides.directSow, season);

  let harvest: Window = null;
  const anchor = transplants ? transplant : directSow;
  if (anchor && timing.maturityDaysMin !== null && timing.maturityDaysMax !== null) {
    harvest = span(anchor.start, timing.maturityDaysMin, timing.maturityDaysMax, anchor.source);
  }

  const hasOverride =
    overrides.indoorStart !== null || overrides.transplant !== null || overrides.directSow !== null;
  let missingReason: MissingReason = null;
  if (!hasOverride) {
    if (!hasTimingData) missingReason = 'no_timing_data';
    else if (frost.frostFree) missingReason = 'frost_free';
    else if (L === null) missingReason = 'no_frost_date';
  }

  return { indoorStart, transplant, directSow, harvest, missingReason };
}

const SEASON_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
});

// The current season is the calendar year in America/Los_Angeles.
export function currentSeason(now: Date): number {
  return Number(SEASON_FORMAT.format(now));
}

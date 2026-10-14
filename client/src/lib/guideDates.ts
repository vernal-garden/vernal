// Calendar-date helpers for the Planting Guide. Dates are YYYY-MM-DD strings
// and are never passed to new Date(str), which would parse them as UTC
// midnight and shift them by the local offset. Arithmetic runs on Date.UTC
// values so no DST transition can move a day.

export interface Day {
  y: number;
  m: number; // 1..12
  d: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const MONTH_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function parseDay(key: string): Day {
  const [y, m, d] = key.split('-').map(Number);
  return { y, m, d };
}

export function toKey(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function toUtc(key: string): number {
  const { y, m, d } = parseDay(key);
  return Date.UTC(y, m - 1, d);
}

function fromUtc(ms: number): string {
  const date = new Date(ms);
  return toKey(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

const PACIFIC_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

// Today's calendar date in America/Los_Angeles, the timezone the server uses
// for seasons.
export function todayPacific(now: Date = new Date()): string {
  const parts = PACIFIC_FORMAT.formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return toKey(get('year'), get('month'), get('day'));
}

// The current season: the calendar year in America/Los_Angeles, matching the
// server's currentSeason(). Never use new Date().getFullYear() for seasons.
export function currentSeasonPacific(now: Date = new Date()): number {
  return parseDay(todayPacific(now)).y;
}

// Whole days from a to b (positive when b is later).
export function daysBetween(a: string, b: string): number {
  return Math.round((toUtc(b) - toUtc(a)) / DAY_MS);
}

export function addDays(key: string, n: number): string {
  return fromUtc(toUtc(key) + n * DAY_MS);
}

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function daysInYear(y: number): number {
  return daysBetween(toKey(y, 1, 1), toKey(y + 1, 1, 1));
}

export function monthStart(y: number, m: number): string {
  return toKey(y, m, 1);
}

export function monthEnd(y: number, m: number): string {
  return toKey(y, m, daysInMonth(y, m));
}

// Where a date sits within its month, for positioning bars on month columns.
export function monthFraction(key: string): { monthIndex: number; fraction: number } {
  const { y, m, d } = parseDay(key);
  return { monthIndex: m - 1, fraction: (d - 1) / daysInMonth(y, m) };
}

export function shortDate(key: string): string {
  const { m, d } = parseDay(key);
  return `${MONTH_SHORT[m - 1]} ${d}`;
}

// "Feb 21 – Mar 7", or "May 10" when the range is a single day.
export function formatRange(start: string, end: string): string {
  return start === end ? shortDate(start) : `${shortDate(start)} – ${shortDate(end)}`;
}

// "around April 11" for an estimated date, "April 11" otherwise.
export function formatAround(key: string, estimated: boolean): string {
  const { m, d } = parseDay(key);
  const text = `${MONTH_LONG[m - 1]} ${d}`;
  return estimated ? `around ${text}` : text;
}

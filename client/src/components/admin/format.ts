// Shared formatters for the admin dashboard. Every function returns "—" for
// null / undefined / unparseable input.

export const EMPTY = '—';

function toDate(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  // A bare 'YYYY-MM-DD' parses as UTC midnight; read it as a local date instead.
  const d = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T00:00:00`)
    : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "Oct 14, 2026" */
export function formatDate(value: string | number | Date | null | undefined): string {
  const d = toDate(value);
  if (!d) return EMPTY;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** "Oct 14, 2026, 3:05 PM" */
export function formatDateTime(value: string | number | Date | null | undefined): string {
  const d = toDate(value);
  if (!d) return EMPTY;
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** "Oct 14, 3 PM" (local time) — for hourly buckets such as sparkline tooltips. */
export function formatHour(value: string | number | Date | null | undefined): string {
  const d = toDate(value);
  if (!d) return EMPTY;
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric' });
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'} ago`;
}

/** "just now", "5 minutes ago", "3 hours ago", "2 days ago"; formatDate after 30 days. */
export function formatRelative(
  value: string | number | Date | null | undefined,
  now: number = Date.now(),
): string {
  const d = toDate(value);
  if (!d) return EMPTY;
  const diff = now - d.getTime();
  if (diff < -MINUTE) return formatDate(d); // future
  if (diff < MINUTE) return 'just now'; // also covers small clock skew
  if (diff < HOUR) return plural(Math.floor(diff / MINUTE), 'minute');
  if (diff < DAY) return plural(Math.floor(diff / HOUR), 'hour');
  if (diff < 30 * DAY) return plural(Math.floor(diff / DAY), 'day');
  return formatDate(d);
}

/**
 * Formats a FRACTION (0..1, e.g. 0.12), not an integer percent, as "12%".
 * One decimal below 10% ("4.5%"), "<0.1%" for tiny non-zero values, "0%" for zero.
 */
export function formatPercent(fraction: number | null | undefined): string {
  if (fraction === null || fraction === undefined || Number.isNaN(fraction)) return EMPTY;
  const pct = fraction * 100;
  if (pct === 0) return '0%';
  if (Math.abs(pct) < 0.05) return '<0.1%';
  if (Math.abs(pct) < 10) return `${Number(pct.toFixed(1))}%`;
  return `${Math.round(pct)}%`;
}

/** 12345 → "12,345" */
export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return EMPTY;
  return value.toLocaleString('en-US');
}

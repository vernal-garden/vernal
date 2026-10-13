import type { HarvestApiFilters } from '../hooks/useHarvests';
import { parseSeedParam } from '../hooks/useHarvests';
import type { SeedParam } from '../types/harvest';
import { daysInMonth, MONTH_SHORT, parseDay, toKey } from './guideDates';

// Harvest log filters. They live in the URL (season, gardenId, seed…, range,
// from, to, q); everything else in the query string (e.g. log) is left alone.

export type RangeKind = 'all' | 'month' | '3m' | 'custom';

export interface HarvestFilters {
  season: number | 'all';
  gardenId: string | null;
  seeds: SeedParam[];
  range: RangeKind;
  from: string | null;
  to: string | null;
  q: string | null;
}

const FILTER_PARAMS = ['season', 'gardenId', 'seed', 'range', 'from', 'to', 'q'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RANGES: RangeKind[] = ['all', 'month', '3m', 'custom'];

export function defaultFilters(currentYear: number): HarvestFilters {
  return { season: currentYear, gardenId: null, seeds: [], range: 'all', from: null, to: null, q: null };
}

// ignoreSeedAndGarden: on a ?log=new deep link, gardenId and seed prefill the
// form rather than filter the list.
export function readFilters(sp: URLSearchParams, currentYear: number, ignoreSeedAndGarden = false): HarvestFilters {
  const f = defaultFilters(currentYear);
  const season = sp.get('season');
  if (season === 'all') f.season = 'all';
  else if (season && /^\d{4}$/.test(season)) f.season = Number(season);

  if (!ignoreSeedAndGarden) {
    const gardenId = sp.get('gardenId');
    if (gardenId && /^\d+$/.test(gardenId)) f.gardenId = gardenId;
    f.seeds = [...new Set(sp.getAll('seed').map(parseSeedParam).filter((s): s is SeedParam => s !== null))];
  }

  const range = sp.get('range') as RangeKind | null;
  if (range && RANGES.includes(range)) f.range = range;
  if (f.range === 'custom') {
    const from = sp.get('from');
    const to = sp.get('to');
    f.from = from && DATE_RE.test(from) ? from : null;
    f.to = to && DATE_RE.test(to) ? to : null;
  }
  const q = sp.get('q')?.trim();
  f.q = q ? q : null;
  return f;
}

// Returns a copy of sp with the filter params replaced by f (defaults omitted).
export function writeFilters(sp: URLSearchParams, f: HarvestFilters, currentYear: number): URLSearchParams {
  const next = new URLSearchParams(sp);
  for (const name of FILTER_PARAMS) next.delete(name);
  if (f.season !== currentYear) next.set('season', String(f.season));
  if (f.gardenId) next.set('gardenId', f.gardenId);
  for (const s of f.seeds) next.append('seed', s);
  if (f.range !== 'all') next.set('range', f.range);
  if (f.range === 'custom') {
    if (f.from) next.set('from', f.from);
    if (f.to) next.set('to', f.to);
  }
  if (f.q) next.set('q', f.q);
  return next;
}

// "?season=…" for links that keep the current filters (empty when default).
export function filterSearch(f: HarvestFilters, currentYear: number): string {
  const s = writeFilters(new URLSearchParams(), f, currentYear).toString();
  return s ? `?${s}` : '';
}

export function isFiltered(f: HarvestFilters, currentYear: number): boolean {
  return filterSearch(f, currentYear) !== '';
}

function monthsBefore(today: string, months: number): string {
  const { y, m, d } = parseDay(today);
  const total = y * 12 + (m - 1) - months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return toKey(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

export function rangeDates(f: HarvestFilters, today: string): { from: string | null; to: string | null } {
  const { y, m } = parseDay(today);
  switch (f.range) {
    case 'month':
      return { from: toKey(y, m, 1), to: today };
    case '3m':
      return { from: monthsBefore(today, 3), to: today };
    case 'custom':
      return { from: f.from, to: f.to };
    default:
      return { from: null, to: null };
  }
}

export function toApiFilters(f: HarvestFilters, today: string): HarvestApiFilters {
  const { from, to } = rangeDates(f, today);
  return {
    season: f.season === 'all' ? null : f.season,
    gardenId: f.gardenId,
    seeds: f.seeds,
    from,
    to,
    q: f.q,
  };
}

// The export panel's default range: a season is Jan 1 – Dec 31 of it, clipped
// to today; a date range wins; 'all' with no range is all time (empty).
export function exportRange(f: HarvestFilters, today: string): { from: string; to: string } {
  const range = rangeDates(f, today);
  if (range.from || range.to) return { from: range.from ?? '', to: range.to ?? '' };
  if (f.season === 'all') return { from: '', to: '' };
  const end = toKey(f.season, 12, 31);
  return { from: toKey(f.season, 1, 1), to: end > today ? today : end };
}

function shortDate(key: string): string {
  const { y, m, d } = parseDay(key);
  return `${MONTH_SHORT[m - 1]} ${d}, ${y}`;
}

export interface Chip {
  key: string;
  label: string;
  remove: (f: HarvestFilters) => HarvestFilters;
}

export function filterChips(
  f: HarvestFilters,
  currentYear: number,
  names: { garden: (id: string) => string; seed: (s: SeedParam) => string },
): Chip[] {
  const chips: Chip[] = [];
  if (f.season !== currentYear) {
    chips.push({
      key: 'season',
      label: f.season === 'all' ? 'All seasons' : `Season ${f.season}`,
      remove: (x) => ({ ...x, season: currentYear }),
    });
  }
  if (f.gardenId) {
    chips.push({ key: 'garden', label: names.garden(f.gardenId), remove: (x) => ({ ...x, gardenId: null }) });
  }
  for (const s of f.seeds) {
    chips.push({ key: `seed-${s}`, label: names.seed(s), remove: (x) => ({ ...x, seeds: x.seeds.filter((v) => v !== s) }) });
  }
  if (f.range !== 'all') {
    const label =
      f.range === 'month'
        ? 'This month'
        : f.range === '3m'
          ? 'Last 3 months'
          : f.from && f.to
            ? `${shortDate(f.from)} – ${shortDate(f.to)}`
            : f.from
              ? `From ${shortDate(f.from)}`
              : f.to
                ? `Until ${shortDate(f.to)}`
                : 'Custom dates';
    chips.push({ key: 'range', label, remove: (x) => ({ ...x, range: 'all', from: null, to: null }) });
  }
  if (f.q) chips.push({ key: 'q', label: `“${f.q}”`, remove: (x) => ({ ...x, q: null }) });
  return chips;
}

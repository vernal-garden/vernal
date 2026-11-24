// Row-level helpers shared by the Planting Guide views. No window math here:
// the API computes every sowing window; this only reads them.

import type { GuideGarden, GuideRow, GuideWindow, WindowKind, WindowSource } from '../types/plantingGuide';
import { addDays, monthEnd, monthStart } from './guideDates';
import type { PlantingState } from '../hooks/usePlantings';
import type { NudgeKind } from './planningStrings';
import { windowSourceLabel } from './frostLabels';

export type SowType = 'indoors' | 'direct';
export type GuideView = 'calendar' | 'timeline' | 'list';

export interface GuideFilterState {
  gardenId: 'all' | string;
  sowType: 'all' | SowType;
  dueThisMonth: boolean;
}

export const WINDOW_KINDS: WindowKind[] = ['indoorStart', 'transplant', 'directSow', 'harvest'];

export const WINDOW_NAMES: Record<WindowKind | 'none', string> = {
  indoorStart: 'Start indoors',
  transplant: 'Transplant out',
  directSow: 'Direct sow',
  harvest: 'Harvest',
  none: 'No dates yet',
};

export function rowKey(row: GuideRow): string {
  return `${row.gardenId}:${row.seedId ?? 'c' + row.cambiumSeedId}`;
}

export function sowType(row: GuideRow): SowType {
  return row.weeksToTransplant != null ? 'indoors' : 'direct';
}

export function rowName(row: GuideRow): string {
  return row.commonName ?? 'Unnamed plant';
}

// "seed:<id>" for a personal seed, "cambium:<id>" for a community one.
export function seedParam(row: GuideRow): string {
  return row.seedId !== null ? `seed:${row.seedId}` : `cambium:${row.cambiumSeedId}`;
}

export interface RowWindow {
  kind: WindowKind;
  window: GuideWindow;
}

export function rowWindows(row: GuideRow): RowWindow[] {
  return WINDOW_KINDS.flatMap((kind) => {
    const w = row.windows[kind];
    return w ? [{ kind, window: w }] : [];
  });
}

export function hasWindows(row: GuideRow): boolean {
  return rowWindows(row).length > 0;
}

export function isDone(row: GuideRow, now: Date = new Date()): boolean {
  const at = row.done?.markedDoneAt;
  return at != null && Date.parse(at) <= now.getTime();
}

interface PlannedMatchInput {
  gardenId: string;
  seedId: string | null;
  cambiumSeedId: string | null;
  state: PlantingState;
}

function planningMatch(row: GuideRow, p: PlannedMatchInput): boolean {
  if (p.state !== 'planned' || p.gardenId !== row.gardenId) return false;
  return row.seedId !== null ? p.seedId === row.seedId : p.cambiumSeedId === row.cambiumSeedId;
}

export function rowHasPlanned(row: GuideRow, plantings: PlannedMatchInput[]): boolean {
  return plantings.some((p) => planningMatch(row, p));
}

export interface PlannedNudge {
  kind: NudgeKind;
  closing: boolean;
  endsOn: string;
}

const NUDGE_KINDS: NudgeKind[] = ['indoorStart', 'transplant', 'directSow'];

// Nudge for a planned plant whose sowing window is open today. Picks the
// window that ends first (ties in kind order).
export function plannedNudge(
  row: GuideRow,
  plantings: PlannedMatchInput[],
  today: string,
  readOnly: boolean,
): PlannedNudge | null {
  if (readOnly || !rowHasPlanned(row, plantings)) return null;
  let best: PlannedNudge | null = null;
  for (const kind of NUDGE_KINDS) {
    const w = row.windows[kind];
    if (!w || w.start > today || today > w.end) continue;
    if (best === null || w.end < best.endsOn) {
      best = { kind, closing: w.end <= addDays(today, 7), endsOn: w.end };
    }
  }
  return best;
}

// "Log harvest" shows once the plant is in the ground and its harvest window
// has opened. `today` is a Pacific YYYY-MM-DD, compared as a string.
export function canLogHarvest(row: GuideRow, today: string, readOnly: boolean): boolean {
  const harvest = row.windows.harvest;
  return !readOnly && isDone(row) && harvest != null && today >= harvest.start;
}

// The sowing item the "Planted" tag belongs to: the indoor start, or the
// direct sow when there is no indoor start.
export function sowingKind(row: GuideRow): WindowKind | null {
  if (row.windows.indoorStart) return 'indoorStart';
  if (row.windows.directSow) return 'directSow';
  return null;
}

export function overlaps(w: { start: string; end: string }, start: string, end: string): boolean {
  return w.start <= end && w.end >= start;
}

export function dueInMonth(row: GuideRow, season: number, month: number): boolean {
  const start = monthStart(season, month);
  const end = monthEnd(season, month);
  return rowWindows(row).some(({ window }) => overlaps(window, start, end));
}

export function filterRows(
  rows: GuideRow[],
  filters: GuideFilterState,
  season: number,
  currentMonth: number,
): GuideRow[] {
  return rows.filter((row) => {
    if (filters.gardenId !== 'all' && row.gardenId !== filters.gardenId) return false;
    if (filters.sowType !== 'all' && sowType(row) !== filters.sowType) return false;
    if (filters.dueThisMonth && !dueInMonth(row, season, currentMonth)) return false;
    return true;
  });
}

export function sourceLabel(source: WindowSource | null): string {
  return windowSourceLabel(source);
}

// Span of the dashed "No dates yet" bar: the garden's frost-free season when
// known, otherwise Mar 1 – Oct 31.
export function placeholderSpan(garden: GuideGarden | undefined, season: number): { start: string; end: string } {
  const last = garden?.frost.lastSpringFrost;
  const first = garden?.frost.firstFallFrost;
  if (last && first && last < first) return { start: last, end: first };
  return { start: monthStart(season, 3), end: monthEnd(season, 10) };
}

// Greedy lane assignment so overlapping bars in one row stack vertically.
export function assignLanes<T extends { start: string; end: string }>(items: T[]): { item: T; lane: number }[] {
  const sorted = [...items].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  const laneEnds: string[] = [];
  return sorted.map((item) => {
    let lane = laneEnds.findIndex((end) => end < item.start);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = item.end;
    return { item, lane };
  });
}

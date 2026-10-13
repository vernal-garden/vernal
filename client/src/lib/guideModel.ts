// Row-level helpers shared by the Planting Guide views. No window math here:
// the API computes every sowing window; this only reads them.

import type { GuideGarden, GuideRow, GuideWindow, WindowKind, WindowSource } from '../types/plantingGuide';
import { monthEnd, monthStart } from './guideDates';

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

export function isDone(row: GuideRow): boolean {
  return row.done?.markedDoneAt != null;
}

// The window the "done" checkbox belongs to: the indoor start, or the direct
// sow when there is no indoor start.
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
  switch (source) {
    case 'custom': return 'Your custom date';
    case 'account_frost': return 'Based on your frost dates';
    case 'zone_estimate': return 'Estimated from your zone';
    default: return 'No data, add manually';
  }
}

export function gardenSourceLabel(garden: GuideGarden): string {
  if (garden.frost.frostFree) return 'Frost-free zone';
  return sourceLabel(garden.frost.frostSource);
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

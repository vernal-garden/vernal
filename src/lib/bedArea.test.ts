import { describe, it, expect } from 'vitest';
import { bedAreaSqFt, type BedAreaInput } from './bedArea';

const grid = (cols: number | null, rows: number | null): BedAreaInput => ({
  type: 'grid',
  grid_cols: cols,
  grid_rows: rows,
  freeform_points: null,
  freeform_closed: null,
});

const freeform = (points: unknown, closed: boolean | null): BedAreaInput => ({
  type: 'freeform',
  grid_cols: null,
  grid_rows: null,
  freeform_points: points,
  freeform_closed: closed,
});

describe('bedAreaSqFt', () => {
  it('multiplies grid columns by rows (1 ft per cell)', () => {
    expect(bedAreaSqFt(grid(4, 8))).toBe(32);
  });

  it('returns null for a grid bed without positive integer dimensions', () => {
    expect(bedAreaSqFt(grid(null, 8))).toBeNull();
    expect(bedAreaSqFt(grid(0, 8))).toBeNull();
    expect(bedAreaSqFt(grid(2.5, 8))).toBeNull();
  });

  it('computes a closed freeform shape by the shoelace formula (900 px² per sq ft)', () => {
    expect(bedAreaSqFt(freeform([0, 0, 60, 0, 60, 60, 0, 60], true))).toBe(4);
  });

  it('is independent of winding direction', () => {
    expect(bedAreaSqFt(freeform([0, 60, 60, 60, 60, 0, 0, 0], true))).toBe(4);
  });

  it('returns null for an open polygon', () => {
    expect(bedAreaSqFt(freeform([0, 0, 60, 0, 60, 60, 0, 60], false))).toBeNull();
  });

  it('returns null for fewer than 3 points', () => {
    expect(bedAreaSqFt(freeform([0, 0, 60, 0], true))).toBeNull();
  });

  it('returns null for malformed points', () => {
    expect(bedAreaSqFt(freeform([0, 0, 60, 0, 60], true))).toBeNull();
    expect(bedAreaSqFt(freeform([0, 0, 60, 0, 60, 'x'], true))).toBeNull();
    expect(bedAreaSqFt(freeform([0, 0, 60, 0, 60, NaN], true))).toBeNull();
    expect(bedAreaSqFt(freeform({ a: 1 }, true))).toBeNull();
  });
});

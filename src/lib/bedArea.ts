// Bed area in square feet for yield-per-sq-ft metrics (Phase 49). The canvas
// draws 30 px per foot, so 900 px² is one square foot and a grid cell is 1 ft.

const PX_PER_SQ_FT = 900;

export interface BedAreaInput {
  type: string;
  grid_cols: number | null;
  grid_rows: number | null;
  freeform_points: unknown; // JSONB; a flat [x1, y1, x2, y2, ...] number array
  freeform_closed: boolean | null;
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

// Null when the bed has no usable dimensions (including open freeform shapes).
export function bedAreaSqFt(bed: BedAreaInput): number | null {
  if (bed.type === 'grid') {
    return isPositiveInt(bed.grid_cols) && isPositiveInt(bed.grid_rows)
      ? bed.grid_cols * bed.grid_rows
      : null;
  }
  if (bed.type === 'freeform') {
    const pts = bed.freeform_points;
    if (bed.freeform_closed !== true || !Array.isArray(pts)) return null;
    if (pts.length < 6 || pts.length % 2 !== 0) return null;
    if (!pts.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
    const p = pts as number[];
    let twice = 0;
    for (let i = 0; i < p.length; i += 2) {
      const j = (i + 2) % p.length;
      twice += p[i] * p[j + 1] - p[j] * p[i + 1];
    }
    return Math.abs(twice) / 2 / PX_PER_SQ_FT;
  }
  return null;
}

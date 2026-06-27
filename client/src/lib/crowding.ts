import { GRID_PX, shoelaceArea } from './fit';
import type { Garden, Bed } from '../hooks/useGarden';
import type { Planting } from '../hooks/usePlantings';

export interface OccupancyResult {
  consumed: number;
  capacity: number;
  over: boolean;
}

export function computeBedOccupancy({
  garden,
  bed,
  plantings,
}: {
  garden: Garden;
  bed: Bed;
  plantings: Planting[];
}): OccupancyResult {
  const EPSILON = 0.01;

  if (bed.type === 'grid' && bed.grid) {
    const { cols, rows } = bed.grid;
    const cells = cols * rows;
    let consumed = 0;

    for (const p of plantings) {
      if (p.spacingInches == null) continue;
      const qty = p.quantity ?? 1;
      const s = p.spacingInches;

      if (garden.growingMethod === 'square_foot') {
        if (s <= 12) {
          const perCell = Math.floor(12 / s) ** 2;
          consumed += qty / perCell; // footprint in cells
        } else {
          const squaresPer = Math.ceil(s / 12) ** 2;
          consumed += qty * squaresPer; // footprint in cells
        }
      } else {
        // Non-SFG grid: spacing^2 / 144 sq ft per plant; capacity is cols*rows sq ft
        consumed += qty * (s * s) / 144;
      }
    }

    const capacity = cells; // SFG: cells; non-SFG: cols*rows sq ft (cols/rows are in feet)
    return { consumed, capacity, over: consumed > capacity + EPSILON };
  }

  if (bed.type === 'freeform' && bed.freeform) {
    const areaSqFt = shoelaceArea(bed.freeform.points) / (GRID_PX * GRID_PX);
    let consumed = 0;

    for (const p of plantings) {
      if (p.spacingInches == null) continue;
      const qty = p.quantity ?? 1;
      const s = p.spacingInches;
      consumed += qty * Math.PI * (s / 2) ** 2 / 144;
    }

    return { consumed, capacity: areaSqFt, over: consumed > areaSqFt + EPSILON };
  }

  return { consumed: 0, capacity: 0, over: false };
}

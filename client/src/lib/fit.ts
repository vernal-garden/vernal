import type { Garden, Bed } from '../hooks/useGarden';

export const GRID_PX = 30; // must match GardenCanvas.GRID_PX

export type FitResult =
  | { mode: 'sfg'; perCell: number; total: number }
  | { mode: 'sfg-large'; squaresPer: number; total: number }
  | { mode: 'grid'; total: number }
  | { mode: 'freeform'; total: number; approximate: true };

function shoelaceArea(points: number[]): number {
  let area = 0;
  const n = points.length / 2;
  for (let i = 0; i < n; i++) {
    const x1 = points[i * 2], y1 = points[i * 2 + 1];
    const x2 = points[((i + 1) % n) * 2], y2 = points[((i + 1) % n) * 2 + 1];
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area) / 2;
}

export function computeFit({
  garden,
  bed,
  spacingInches,
}: {
  garden: Garden;
  bed: Bed;
  spacingInches: number;
}): FitResult {
  if (bed.type === 'grid' && bed.grid) {
    const { cols, rows } = bed.grid;
    const cells = cols * rows;

    if (garden.growingMethod === 'square_foot') {
      if (spacingInches <= 12) {
        const perCell = Math.floor(12 / spacingInches) ** 2;
        return { mode: 'sfg', perCell, total: perCell * cells };
      } else {
        const squaresPer = Math.ceil(spacingInches / 12) ** 2;
        return { mode: 'sfg-large', squaresPer, total: Math.floor(cells / squaresPer) };
      }
    }

    // Non-SFG grid: cols/rows are in feet
    const total =
      Math.floor((cols * 12) / spacingInches) *
      Math.floor((rows * 12) / spacingInches);
    return { mode: 'grid', total };
  }

  if (bed.type === 'freeform' && bed.freeform) {
    const areaSqFt = shoelaceArea(bed.freeform.points) / (GRID_PX * GRID_PX);
    const total = Math.floor(
      (areaSqFt * 144) / (Math.PI * (spacingInches / 2) ** 2),
    );
    return { mode: 'freeform', total, approximate: true };
  }

  return { mode: 'grid', total: 0 };
}

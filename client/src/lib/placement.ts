// Pure placement helpers for the canvas: quantity pre-fill, "same plant"
// matching for occupied grid cells, and plant-count copy.
import type { ArmedSeed, Planting } from '../hooks/usePlantings';

export const PLANTS_HERE_MAX = 99;

// Square-foot style pre-fill: a 1 ft grid cell fits floor(12 / spacing)^2
// plants. Freeform beds, missing spacing and spacing over a foot pre-fill 1.
export function prefillQuantity(bedType: 'grid' | 'freeform', spacingInches: number | null): number {
  if (spacingInches == null || !(spacingInches > 0)) return 1;
  if (bedType === 'freeform') return 1;
  if (spacingInches <= 12) return Math.min(PLANTS_HERE_MAX, Math.floor(12 / spacingInches) ** 2);
  return 1;
}

// Same seed record, or else the same Cambium identity. Null identities match
// only by seed record.
export function isSamePlant(p: Planting, seed: ArmedSeed): boolean {
  if (seed.source === 'personal' && p.seedId != null && String(p.seedId) === seed.id) return true;
  if (seed.source === 'catalogue' && p.cambiumSeedId != null && String(p.cambiumSeedId) === seed.id) return true;
  return p.companionSeedId != null
    && seed.cambiumIdentity != null
    && String(p.companionSeedId) === String(seed.cambiumIdentity);
}

export function plantCount(plantings: Planting[]): number {
  return plantings.reduce((sum, p) => sum + p.quantity, 0);
}

export function plantsLabel(n: number): string {
  return n === 1 ? '1 plant' : `${n} plants`;
}

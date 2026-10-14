// Client copy of the growth-stage names (server: src/lib/growthStages.ts).

import type { Planting } from '../hooks/usePlantings';

export type GrowthStage = 1 | 2 | 3 | 4 | 5;

export const STAGE_NAMES: Record<GrowthStage, string> = {
  1: 'Seed',
  2: 'Seedling',
  3: 'Vegetative',
  4: 'Flowering / fruiting',
  5: 'Harvest-ready',
};

// harvest_ready stays true on the server until the nightly job after a
// dismiss, so a dismissed indicator counts as not ready here.
export function isHarvestReady(planting: Planting): boolean {
  return planting.growth.harvestReady && !planting.growth.indicatorDismissedAt;
}

// Client copy of the growth-stage names (server: src/lib/growthStages.ts).

import type { Planting } from '../hooks/usePlantings';
import type { CropClass } from './illustrations';

export type GrowthStage = 1 | 2 | 3 | 4 | 5;

export const STAGE_NAMES: Record<GrowthStage, string> = {
  1: 'Seed',
  2: 'Seedling',
  3: 'Vegetative',
  4: 'Flowering / fruiting',
  5: 'Harvest-ready',
};

const STAGE_4_LABELS: Record<CropClass, string> = {
  F: 'Flowering',
  L: 'Sizing up',
  B: 'Heading up',
};

// Marker and card copy for a stage. Stage 4 depends on the crop class; a crop
// with no art (null class) reads 'Maturing'.
export function stageLabel(stage: GrowthStage, cls: CropClass | null): string {
  switch (stage) {
    case 1: return 'Seed';
    case 2: return 'Seedling';
    case 3: return 'Leafing out';
    case 4: return cls ? STAGE_4_LABELS[cls] : 'Maturing';
    case 5: return 'Ready to harvest';
  }
}

// harvest_ready stays true on the server until the nightly job after a
// dismiss, so a dismissed indicator counts as not ready here.
export function isHarvestReady(planting: Planting): boolean {
  return planting.growth.harvestReady && !planting.growth.indicatorDismissedAt;
}

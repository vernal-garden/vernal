// Growth stage rules. A planting's growth_stage_pct maps to one of five stages;
// the upper bound of each stage is inclusive. The nightly job applies the same
// bounds in SQL (passed as parameters), so change them here only. Callers
// should pass the stored 2-decimal pct: the SQL rounds before choosing a stage.

export type GrowthStage = 1 | 2 | 3 | 4 | 5;

export const STAGE_BOUNDS = { seedling: 25, vegetative: 65, ready: 100 };

export const STAGE_NAMES: Record<GrowthStage, string> = {
  1: 'Seed',
  2: 'Seedling',
  3: 'Vegetative',
  4: 'Flowering / fruiting',
  5: 'Harvest-ready',
};

export function stageFor(pct: number | null): GrowthStage | null {
  if (pct === null) return null;
  if (pct >= STAGE_BOUNDS.ready) return 5;
  if (pct > STAGE_BOUNDS.vegetative) return 4;
  if (pct > STAGE_BOUNDS.seedling) return 3;
  if (pct > 0) return 2;
  return 1;
}

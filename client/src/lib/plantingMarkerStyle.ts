import type { PlantingState } from '../hooks/usePlantings';
import type { GrowthStage } from './growthStages';

export interface MarkerStyle {
  circleOpacity: number;
  // Screen-pixel values; the component divides by the canvas scale.
  dashed: { widthPx: number; dashPx: [number, number] } | null;
  artStage: GrowthStage | null;
}

export function markerStyleFor(p: {
  state: PlantingState;
  growth: { stage: GrowthStage | null; anchored: boolean };
}): MarkerStyle {
  if (p.state === 'planned') {
    return { circleOpacity: 0.4, dashed: { widthPx: 1.5, dashPx: [4, 3] }, artStage: 5 };
  }
  return { circleOpacity: 0.88, dashed: null, artStage: p.growth.anchored ? p.growth.stage : null };
}

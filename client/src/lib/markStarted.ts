import type { PlantingState, StartMethod } from '../hooks/usePlantings';
import { CHOOSE_PLANTS, markInGround } from './planningStrings';

// Structural row type so Planting (once it has `state`) is assignable.
export interface PlannedRowInput {
  id: string;
  seedId: string | null;
  cambiumSeedId: string | null;
  companionSeedId: string | null;
  commonName?: string | null;
  _commonName?: string;
  quantity: number;
  startMethod: StartMethod;
  state: PlantingState;
}

export interface PlantGroup {
  key: string;
  name: string;
  plantingIds: string[];
  quantity: number;
  startMethod: StartMethod;
}

export function groupPlannedByPlant(plantings: PlannedRowInput[]): PlantGroup[] {
  const groups = new Map<string, PlantGroup>();
  for (const p of plantings) {
    if (p.state !== 'planned') continue;
    const key = p.cambiumSeedId ?? p.seedId ?? p.companionSeedId ?? p.id;
    const g = groups.get(key);
    if (g) {
      g.plantingIds.push(p.id);
      g.quantity += p.quantity;
    } else {
      groups.set(key, {
        key,
        name: p.commonName ?? p._commonName ?? 'Plant',
        plantingIds: [p.id],
        quantity: p.quantity,
        startMethod: p.startMethod,
      });
    }
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function saveButtonState(groups: Array<{ quantity: number; checked: boolean }>): {
  label: string;
  disabled: boolean;
} {
  const n = groups.reduce((sum, g) => sum + (g.checked ? g.quantity : 0), 0);
  return n === 0 ? { label: CHOOSE_PLANTS, disabled: true } : { label: markInGround(n), disabled: false };
}

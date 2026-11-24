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

export interface MarkSavePlan {
  // The method the control shows, or null when the control is hidden
  // (nothing ticked, or ticked plantings planned with different methods).
  controlMethod: StartMethod | null;
  mixed: boolean;
  // One entry per markStarted request, 'sown' first, then 'transplanted'.
  calls: Array<{ startMethod: StartMethod; ids: string[] }>;
}

const METHOD_ORDER: StartMethod[] = ['sown', 'transplanted'];

// Decides per planting, not per row: one plant's plantings can be planned
// with different methods.
export function planMarkSave(
  plantings: Array<{ id: string; startMethod: StartMethod; state: PlantingState }>,
  checkedIds: string[],
  override: StartMethod | null,
): MarkSavePlan {
  const checked = new Set(checkedIds);
  const byMethod = new Map<StartMethod, string[]>();
  for (const p of plantings) {
    if (p.state !== 'planned' || !checked.has(p.id)) continue;
    const ids = byMethod.get(p.startMethod);
    if (ids) ids.push(p.id); else byMethod.set(p.startMethod, [p.id]);
  }
  if (byMethod.size === 0) return { controlMethod: null, mixed: false, calls: [] };
  if (byMethod.size === 1) {
    const [[method, ids]] = [...byMethod];
    const controlMethod = override ?? method;
    return { controlMethod, mixed: false, calls: [{ startMethod: controlMethod, ids }] };
  }
  const calls = METHOD_ORDER.flatMap(m => {
    const ids = byMethod.get(m);
    return ids ? [{ startMethod: m, ids }] : [];
  });
  return { controlMethod: null, mixed: true, calls };
}

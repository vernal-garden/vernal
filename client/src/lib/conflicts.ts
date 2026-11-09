import type { Bed } from '../hooks/useGarden';
import type { Planting, PlantingsByBedId } from '../hooks/usePlantings';
import { GRID_PX } from './fit';

export interface ConflictResult {
  conflictedIds: Set<string>;
  conflictedBedIds: Set<string>;
  // Each conflicted planting id → the ids of the plantings it conflicts with.
  conflictsByPlantingId: Map<string, Set<string>>;
}

export function deriveConflicts({
  beds,
  plantingsByBedId,
  relationshipBetween,
}: {
  beds: Bed[];
  plantingsByBedId: PlantingsByBedId;
  relationshipBetween: (a: string, b: string) => 'beneficial' | 'antagonistic' | null;
}): ConflictResult {
  const conflictedIds = new Set<string>();
  const conflictedBedIds = new Set<string>();
  const conflictsByPlantingId = new Map<string, Set<string>>();

  const addPair = (aId: string, bId: string) => {
    let aSet = conflictsByPlantingId.get(aId);
    if (!aSet) { aSet = new Set(); conflictsByPlantingId.set(aId, aSet); }
    aSet.add(bId);
    let bSet = conflictsByPlantingId.get(bId);
    if (!bSet) { bSet = new Set(); conflictsByPlantingId.set(bId, bSet); }
    bSet.add(aId);
  };

  for (const bed of beds) {
    const plantings = plantingsByBedId[bed.id] ?? [];

    if (bed.type === 'grid') {
      // Grid: adjacent = |dx| + |dy| === 1
      for (let i = 0; i < plantings.length; i++) {
        for (let j = i + 1; j < plantings.length; j++) {
          const a = plantings[i];
          const b = plantings[j];
          if (a.companionSeedId == null || b.companionSeedId == null) continue;
          if (a.cell == null || b.cell == null) continue;
          const dx = Math.abs(a.cell.x - b.cell.x);
          const dy = Math.abs(a.cell.y - b.cell.y);
          if (dx + dy !== 1) continue;
          if (relationshipBetween(a.companionSeedId, b.companionSeedId) === 'antagonistic') {
            conflictedIds.add(a.id);
            conflictedIds.add(b.id);
            conflictedBedIds.add(bed.id);
            addPair(a.id, b.id);
          }
        }
      }
    } else if (bed.type === 'freeform') {
      // Freeform: adjacent if distance < (spacingPxA/2 + spacingPxB/2)
      for (let i = 0; i < plantings.length; i++) {
        for (let j = i + 1; j < plantings.length; j++) {
          const a = plantings[i];
          const b = plantings[j];
          if (a.companionSeedId == null || b.companionSeedId == null) continue;
          if (a.spacingInches == null || b.spacingInches == null) continue;
          if (a.point == null || b.point == null) continue;
          const spacingPxA = a.spacingInches * (GRID_PX / 12);
          const spacingPxB = b.spacingInches * (GRID_PX / 12);
          const dx = a.point.x - b.point.x;
          const dy = a.point.y - b.point.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const threshold = Math.max(spacingPxA / 2 + spacingPxB / 2, GRID_PX);
          if (dist >= threshold) continue;
          if (relationshipBetween(a.companionSeedId, b.companionSeedId) === 'antagonistic') {
            conflictedIds.add(a.id);
            conflictedIds.add(b.id);
            conflictedBedIds.add(bed.id);
            addPair(a.id, b.id);
          }
        }
      }
    }
  }

  return { conflictedIds, conflictedBedIds, conflictsByPlantingId };
}

// The inspect popover's "Conflicts with X" lines: one per neighbouring seed,
// sorted by name, capped at two with the rest counted in `more`.
export function conflictLines(
  plantingId: string,
  bedPlantings: Planting[],
  conflictsByPlantingId: Map<string, Set<string>>,
): { names: string[]; more: number } {
  const neighbourIds = conflictsByPlantingId.get(plantingId);
  if (!neighbourIds) return { names: [], more: 0 };

  const byId = new Map(bedPlantings.map(p => [p.id, p]));
  const seenSeeds = new Set<string>();
  const names: string[] = [];
  for (const id of neighbourIds) {
    const p = byId.get(id);
    if (!p) continue;
    // Two plantings of the same seed give one line.
    if (p.companionSeedId != null) {
      if (seenSeeds.has(p.companionSeedId)) continue;
      seenSeeds.add(p.companionSeedId);
    }
    const name = p.commonName ?? p._commonName;
    if (!name) continue;
    names.push(name);
  }

  names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  return { names: names.slice(0, 2), more: Math.max(0, names.length - 2) };
}

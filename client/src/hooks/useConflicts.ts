import { useMemo } from 'react';
import { GRID_PX } from '../lib/fit';
import type { Bed } from './useGarden';
import type { PlantingsByBedId } from './usePlantings';

export interface ConflictResult {
  conflictedIds: Set<string>;
  conflictedBedIds: Set<string>;
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
          if (dist >= spacingPxA / 2 + spacingPxB / 2) continue;
          if (relationshipBetween(a.companionSeedId, b.companionSeedId) === 'antagonistic') {
            conflictedIds.add(a.id);
            conflictedIds.add(b.id);
            conflictedBedIds.add(bed.id);
          }
        }
      }
    }
  }

  return { conflictedIds, conflictedBedIds };
}

export function useConflicts({
  beds,
  plantingsByBedId,
  relationshipBetween,
  cacheVersion,
}: {
  beds: Bed[];
  plantingsByBedId: PlantingsByBedId;
  relationshipBetween: (a: string, b: string) => 'beneficial' | 'antagonistic' | null;
  cacheVersion: number;
}): ConflictResult {
  return useMemo(
    () => deriveConflicts({ beds, plantingsByBedId, relationshipBetween }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [beds, plantingsByBedId, relationshipBetween, cacheVersion],
  );
}

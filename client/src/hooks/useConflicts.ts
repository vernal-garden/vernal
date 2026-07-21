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
          // [ring-diag] grid pair inspection
          {
            const _dx = a.cell && b.cell ? Math.abs(a.cell.x - b.cell.x) : null;
            const _dy = a.cell && b.cell ? Math.abs(a.cell.y - b.cell.y) : null;
            const _rel = (a.companionSeedId && b.companionSeedId)
              ? relationshipBetween(a.companionSeedId, b.companionSeedId) : 'no-seed-id';
            console.log('[ring-diag][grid]', {
              bed: bed.id, aId: a.id, bId: b.id,
              aSeed: a.companionSeedId, bSeed: b.companionSeedId,
              aCell: a.cell, bCell: b.cell,
              dx: _dx, dy: _dy, adjacent: _dx != null && (_dx + _dy!) === 1,
              rel: _rel,
            });
          }
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
          // [ring-diag] freeform pair inspection
          {
            let _dist: number | null = null;
            let _threshold: number | null = null;
            if (a.point && b.point && a.spacingInches != null && b.spacingInches != null) {
              const _spA = a.spacingInches * (GRID_PX / 12);
              const _spB = b.spacingInches * (GRID_PX / 12);
              const _ddx = a.point.x - b.point.x;
              const _ddy = a.point.y - b.point.y;
              _dist = Math.sqrt(_ddx * _ddx + _ddy * _ddy);
              _threshold = Math.max(_spA / 2 + _spB / 2, GRID_PX);
            }
            const _rel = (a.companionSeedId && b.companionSeedId)
              ? relationshipBetween(a.companionSeedId, b.companionSeedId) : 'no-seed-id';
            console.log('[ring-diag][freeform]', {
              bed: bed.id, aId: a.id, bId: b.id,
              aSeed: a.companionSeedId, bSeed: b.companionSeedId,
              aPoint: a.point, bPoint: b.point,
              aSpacing: a.spacingInches, bSpacing: b.spacingInches,
              dist: _dist, threshold: _threshold,
              adjacent: _dist != null && _threshold != null && _dist < _threshold,
              rel: _rel,
            });
          }
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
          }
        }
      }
    }
  }

  // [ring-diag] derivation result
  console.log('[ring-diag][result]', {
    conflictedIds: [...conflictedIds],
    conflictedBedIds: [...conflictedBedIds],
    bedCount: beds.length,
  });

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

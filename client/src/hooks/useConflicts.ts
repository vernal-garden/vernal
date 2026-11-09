import { useMemo } from 'react';
import { deriveConflicts } from '../lib/conflicts';
import type { ConflictResult } from '../lib/conflicts';
import type { Bed } from './useGarden';
import type { PlantingsByBedId } from './usePlantings';

export type { ConflictResult } from '../lib/conflicts';

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

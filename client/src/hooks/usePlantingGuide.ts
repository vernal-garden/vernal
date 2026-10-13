import { useCallback, useEffect, useRef, useState } from 'react';
import { get, put } from '../lib/api';
import { track } from '../lib/track';
import type { GuideOverrides, GuideRow, PlantingGuideResponse } from '../types/plantingGuide';

function seedKeyBody(row: GuideRow) {
  return row.seedId !== null ? { seedId: Number(row.seedId) } : { cambiumSeedId: Number(row.cambiumSeedId) };
}

function sameRow(a: GuideRow, b: GuideRow): boolean {
  return a.gardenId === b.gardenId && a.seedId === b.seedId && a.cambiumSeedId === b.cambiumSeedId;
}

// Loads the planting guide for a season. `season` null asks the server for
// its current season (the response's `season` says which one that is).
export function usePlantingGuide(season: number | null) {
  const [data, setData] = useState<PlantingGuideResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Only the latest request may write state.
  const requestId = useRef(0);

  const reload = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const res = await get<PlantingGuideResponse>(
        season === null ? '/api/planting-guide' : `/api/planting-guide?season=${season}`,
      );
      if (id === requestId.current) setData(res ?? null);
    } catch {
      if (id === requestId.current) setError("Couldn't load your planting guide.");
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [season]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const setOverrides = useCallback(
    async (row: GuideRow, partial: Partial<GuideOverrides>) => {
      await put('/api/planting-guide/overrides', {
        gardenId: Number(row.gardenId),
        ...seedKeyBody(row),
        ...partial,
      });
      track('planting_guide_entry_saved');
      await reload();
    },
    [reload],
  );

  const patchRow = useCallback((row: GuideRow, done: GuideRow['done']) => {
    setData((prev) =>
      prev ? { ...prev, rows: prev.rows.map((r) => (sameRow(r, row) ? { ...r, done } : r)) } : prev,
    );
  }, []);

  const setDone = useCallback(
    async (row: GuideRow, done: boolean) => {
      if (!data) return;
      const previous = row.done;
      patchRow(row, {
        sowingEventId: previous?.sowingEventId ?? null,
        markedDoneAt: done ? new Date().toISOString() : null,
      });
      try {
        const res = await put<{ sowingEventId: string | null; markedDoneAt: string | null }>(
          '/api/planting-guide/done',
          { gardenId: Number(row.gardenId), ...seedKeyBody(row), season: data.season, done },
        );
        if (res) patchRow(row, res);
        if (done) track('planting_guide_entry_saved');
      } catch (err) {
        patchRow(row, previous);
        throw err;
      }
    },
    [data, patchRow],
  );

  return { data, loading, error, reload, setOverrides, setDone };
}

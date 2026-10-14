import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as api from '../lib/api';
import { currentSeasonPacific } from '../lib/guideDates';

interface GardenSeasonsResponse {
  currentSeason: number;
  layoutSeasons: number[];
}

// Seasons with a canvas layout for a garden (GET /api/gardens/:id/seasons).
// earlierSeasons is layoutSeasons before the current season, newest first.
export function useGardenSeasons(gardenId: string | null) {
  const [currentSeason, setCurrentSeason] = useState<number>(() => currentSeasonPacific());
  const [layoutSeasons, setLayoutSeasons] = useState<number[]>([]);
  // Garden id the current seasons belong to (set once a fetch resolves, even
  // on failure), so callers can wait for this garden's answer before acting.
  const [loadedGardenId, setLoadedGardenId] = useState<string | null>(null);
  // Latest request wins, so a garden switch mid-fetch can't apply stale seasons.
  const requestRef = useRef(0);

  const refetch = useCallback(async () => {
    if (!gardenId) return;
    const req = ++requestRef.current;
    try {
      const res = await api.get<GardenSeasonsResponse>(`/api/gardens/${gardenId}/seasons`);
      if (req !== requestRef.current || !res) return;
      setCurrentSeason(res.currentSeason);
      setLayoutSeasons(res.layoutSeasons);
      setLoadedGardenId(gardenId);
    } catch {
      if (req !== requestRef.current) return;
      // Overlay is optional: on failure there are simply no earlier seasons.
      setLayoutSeasons([]);
      setLoadedGardenId(gardenId);
    }
  }, [gardenId]);

  useEffect(() => {
    setLayoutSeasons([]);
    setLoadedGardenId(null);
    if (!gardenId) { requestRef.current += 1; return; }
    refetch();
  }, [gardenId, refetch]);

  const earlierSeasons = useMemo(
    () => layoutSeasons.filter(s => s < currentSeason),
    [layoutSeasons, currentSeason],
  );

  return { currentSeason, layoutSeasons, earlierSeasons, loadedGardenId, refetch };
}

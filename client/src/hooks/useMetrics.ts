import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, get } from '../lib/api';
import type { ComparablePlant, CrossSeasonResponse, DashboardResponse } from '../types/metrics';

// Data hooks for the Metrics Dashboard and Cross-Season Comparison. The server
// does all the aggregation; these only fetch.

// Bumps the request id on unmount so a response that lands afterwards is
// ignored instead of setting state on an unmounted component.
function useUnmountGuard(requestId: { current: number }) {
  useEffect(
    () => () => {
      requestId.current++;
    },
    [requestId],
  );
}

// GET /api/metrics/dashboard. `season` null asks for the server's current
// season. `gardenId` filters only the totals. The previous response stays in
// `data` while a new one loads (`loading` is true meanwhile), so a garden
// toggle doesn't blank the page. `loadedGardenId` is the gardenId the
// current `data.totals` were filtered by.
export function useDashboard(season: number | null, gardenId: string | null) {
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [loadedGardenId, setLoadedGardenId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  // Only the latest request may write state.
  const requestId = useRef(0);
  useUnmountGuard(requestId);

  const params = new URLSearchParams();
  if (season !== null) params.set('season', String(season));
  if (gardenId) params.set('gardenId', gardenId);
  const query = params.toString();

  const reload = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    setErrorStatus(null);
    try {
      const res = await get<DashboardResponse>(`/api/metrics/dashboard${query ? `?${query}` : ''}`);
      if (id === requestId.current) {
        setData(res ?? null);
        setLoadedGardenId(gardenId);
      }
    } catch (err) {
      if (id !== requestId.current) return;
      // ED: replace with final copy
      setError("Couldn't load your season's data.");
      setErrorStatus(err instanceof ApiError ? err.status : null);
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [query, gardenId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, loadedGardenId, loading, error, errorStatus, reload };
}

// GET /api/metrics/comparable-plants — plants with harvests in 2+ seasons.
// `enabled` false (e.g. a guest) skips the request and returns no plants.
export function useComparablePlants(enabled = true) {
  const [plants, setPlants] = useState<ComparablePlant[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);
  useUnmountGuard(requestId);

  const reload = useCallback(async () => {
    const id = ++requestId.current;
    if (!enabled) {
      setPlants([]);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await get<{ data: ComparablePlant[] }>('/api/metrics/comparable-plants');
      if (id === requestId.current) setPlants(res?.data ?? []);
    } catch {
      // ED: replace with final copy
      if (id === requestId.current) setError("Couldn't load your plants.");
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { plants, loading, error, reload };
}

export interface CrossSeasonParams {
  plant: string; // seed:<id> | cambium:<id>
  gardenId?: string | null;
  bedId?: string | null;
  // Omitted / null: the server picks the two most recent seasons with data.
  seasons?: number[] | null;
}

export function crossSeasonQuery(p: CrossSeasonParams): string {
  const params = new URLSearchParams();
  params.set('plant', p.plant);
  if (p.gardenId) params.set('gardenId', p.gardenId);
  if (p.bedId) params.set('bedId', p.bedId);
  if (p.seasons && p.seasons.length > 0) params.set('seasons', p.seasons.join(','));
  return params.toString();
}

// GET /api/metrics/cross-season (supporters; 402 otherwise). `params` null
// loads nothing. While a filter change loads, the previous response stays in
// `data`; choosing a different plant clears it.
export function useCrossSeason(params: CrossSeasonParams | null) {
  const [data, setData] = useState<CrossSeasonResponse | null>(null);
  const [loading, setLoading] = useState(params !== null);
  const [error, setError] = useState<string | null>(null);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const requestId = useRef(0);
  useUnmountGuard(requestId);

  const plant = params?.plant ?? null;
  const query = params ? crossSeasonQuery(params) : null;

  // A different plant: drop the old plant's numbers right away (React's
  // "adjust state when a prop changes" pattern).
  const [prevPlant, setPrevPlant] = useState(plant);
  if (prevPlant !== plant) {
    setPrevPlant(plant);
    setData(null);
    setError(null);
    setErrorStatus(null);
  }

  const reload = useCallback(async () => {
    const id = ++requestId.current;
    setError(null);
    setErrorStatus(null);
    if (query === null) {
      setData(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await get<CrossSeasonResponse>(`/api/metrics/cross-season?${query}`);
      if (id === requestId.current) setData(res ?? null);
    } catch (err) {
      if (id !== requestId.current) return;
      const status = err instanceof ApiError ? err.status : null;
      const body = err instanceof ApiError ? (err.body as { error?: unknown } | null) : null;
      setErrorStatus(status);
      setError(
        status === 404 && typeof body?.error === 'string'
          ? body.error
          // ED: replace with final copy
          : "Couldn't load this comparison.",
      );
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, loading, error, errorStatus, reload };
}

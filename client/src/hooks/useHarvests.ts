import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, del, get, patch, post } from '../lib/api';
import type {
  HarvestEntry,
  HarvestInput,
  HarvestListResponse,
  HarvestUnit,
  PlantOption,
  SeedParam,
} from '../types/harvest';

// Filters as the API takes them (the page maps its URL state onto these).
export interface HarvestApiFilters {
  season: number | null;
  gardenId: string | null;
  seeds: SeedParam[];
  from: string | null;
  to: string | null;
  q: string | null;
}

export function harvestQuery(f: Partial<HarvestApiFilters>): URLSearchParams {
  const params = new URLSearchParams();
  if (f.season != null) params.set('season', String(f.season));
  if (f.gardenId) params.set('gardenId', f.gardenId);
  for (const s of f.seeds ?? []) params.append('seed', s);
  if (f.from) params.set('from', f.from);
  if (f.to) params.set('to', f.to);
  if (f.q) params.set('q', f.q);
  return params;
}

// GET /api/harvests, first page; loadMore() appends the next page.
export function useHarvests(filters: HarvestApiFilters) {
  const query = harvestQuery(filters).toString();

  const [entries, setEntries] = useState<HarvestEntry[]>([]);
  const [seasons, setSeasons] = useState<number[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Only the latest request may write state.
  const requestId = useRef(0);

  const reload = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const res = await get<HarvestListResponse>(`/api/harvests${query ? `?${query}` : ''}`);
      if (id !== requestId.current) return;
      setEntries(res?.data ?? []);
      setSeasons(res?.seasons ?? []);
      setNextCursor(res?.nextCursor ?? null);
    } catch {
      if (id === requestId.current) setError("Couldn't load your harvests.");
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const loadMore = useCallback(async () => {
    if (!nextCursor) return;
    const id = requestId.current;
    setLoadingMore(true);
    try {
      const params = new URLSearchParams(query);
      params.set('cursor', nextCursor);
      const res = await get<HarvestListResponse>(`/api/harvests?${params.toString()}`);
      if (id !== requestId.current) return;
      setEntries((prev) => [...prev, ...(res?.data ?? [])]);
      setNextCursor(res?.nextCursor ?? null);
    } catch {
      if (id === requestId.current) setError("Couldn't load your harvests.");
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, query]);

  const removeEntry = useCallback((entryId: string) => {
    setEntries((prev) => prev.filter((e) => e.id !== entryId));
  }, []);

  return { entries, seasons, nextCursor, loading, loadingMore, error, reload, loadMore, removeEntry };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export async function getHarvest(id: string): Promise<HarvestEntry> {
  return (await get<HarvestEntry>(`/api/harvests/${id}`))!;
}

export async function createHarvest(input: HarvestInput): Promise<HarvestEntry> {
  return (await post<HarvestEntry>('/api/harvests', input))!;
}

export async function updateHarvest(id: string, input: HarvestInput): Promise<HarvestEntry> {
  return (await patch<HarvestEntry>(`/api/harvests/${id}`, input))!;
}

export async function deleteHarvest(id: string): Promise<void> {
  await del(`/api/harvests/${id}`);
}

export async function fetchPlantOptions(q: string): Promise<PlantOption[]> {
  const res = await get<{ data: PlantOption[] }>(
    `/api/harvests/plant-options?q=${encodeURIComponent(q)}`,
  );
  return res?.data ?? [];
}

// upload-url → PUT to storage (no credentials) → attach. Returns the entry.
export async function uploadHarvestPhoto(entryId: string, blob: Blob): Promise<HarvestEntry> {
  const target = await post<{ uploadUrl: string; key: string }>(
    `/api/harvests/${entryId}/photos/upload-url`,
    { contentType: 'image/jpeg', size: blob.size },
  );
  const put = await fetch(target!.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/jpeg' },
    body: blob,
  });
  if (!put.ok) throw new ApiError(put.status, null);
  return (await post<HarvestEntry>(`/api/harvests/${entryId}/photos`, { key: target!.key }))!;
}

export async function removeHarvestPhoto(entryId: string, key: string): Promise<HarvestEntry> {
  return (await del<HarvestEntry>(
    `/api/harvests/${entryId}/photos?key=${encodeURIComponent(key)}`,
  ))!;
}

// "12 items" / "1 item"; otherwise "340 g", "1.5 lb" (at most 2 decimals).
export function formatQuantity(quantity: number | null, unit: HarvestUnit | null): string | null {
  if (quantity === null || unit === null) return null;
  const n = String(Math.round(quantity * 100) / 100);
  if (unit === 'count') return `${n} ${quantity === 1 ? 'item' : 'items'}`;
  return `${n} ${unit}`;
}

export function seedParamOf(e: { seedId: string | null; cambiumSeedId: string | null }): SeedParam {
  return e.seedId !== null ? `seed:${e.seedId}` : `cambium:${e.cambiumSeedId}`;
}

export function parseSeedParam(value: string | null): SeedParam | null {
  return value !== null && /^(seed|cambium):\d+$/.test(value) ? (value as SeedParam) : null;
}

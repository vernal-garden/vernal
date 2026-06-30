import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../lib/api';

export interface Planting {
  id: string;
  bedId: string;
  gardenId: string;
  season: number;
  seedId: string | null;
  cambiumSeedId: string | null;
  companionSeedId: string | null;
  spacingInches: number | null;
  commonName?: string | null;
  quantity: number;
  plantingDate: string | null;
  cell: { x: number; y: number } | null;
  point: { x: number; y: number } | null;
  growth: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  _commonName?: string; // client-side display label, not from API
}

export interface ArmedSeed {
  source: 'catalogue' | 'personal';
  id: string;
  commonName: string;
  spacingInches: number;
}

export type PlantingsByBedId = Record<string, Planting[]>;

export function usePlantings(gardenId: string | null) {
  const [plantingsByBedId, setPlantingsByBedId] = useState<PlantingsByBedId>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [latestPlacing, setLatestPlacing] = useState<{ id: string; seq: number } | null>(null);
  const plantingsRef = useRef<PlantingsByBedId>({});
  const seqRef = useRef(0);

  const syncPlantings = useCallback((next: PlantingsByBedId) => {
    plantingsRef.current = next;
    setPlantingsByBedId(next);
  }, []);

  const reload = useCallback(async () => {
    if (!gardenId) return;
    setLoading(true);
    setError(null);
    try {
      const season = new Date().getFullYear();
      const res = await api.get<{ data: Planting[] }>(`/api/gardens/${gardenId}/plantings?season=${season}`);
      const list = res?.data ?? [];
      const byBed: PlantingsByBedId = {};
      for (const p of list) {
        if (!byBed[p.bedId]) byBed[p.bedId] = [];
        byBed[p.bedId].push(p);
      }
      syncPlantings(byBed);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load plantings');
    } finally {
      setLoading(false);
    }
  }, [gardenId, syncPlantings]);

  useEffect(() => {
    if (!gardenId) { syncPlantings({}); return; }
    reload();
  }, [gardenId, reload, syncPlantings]);

  const _addPlanting = useCallback((planting: Planting) => {
    const prev = plantingsRef.current;
    syncPlantings({ ...prev, [planting.bedId]: [...(prev[planting.bedId] ?? []), planting] });
  }, [syncPlantings]);

  const _removePlanting = useCallback((plantingId: string, bedId: string) => {
    const prev = plantingsRef.current;
    syncPlantings({ ...prev, [bedId]: (prev[bedId] ?? []).filter(p => p.id !== plantingId) });
  }, [syncPlantings]);

  const placePlanting = useCallback(async (
    bedId: string,
    payload: {
      seedId?: string;
      cambiumSeedId?: string;
      cell?: { x: number; y: number };
      point?: { x: number; y: number };
      quantity?: number;
      plantingDate?: string;
    },
    commonName?: string,
  ): Promise<void> => {
    if (!gardenId) return;
    const tempId = `temp-${Date.now()}`;
    const optimistic: Planting = {
      id: tempId,
      bedId,
      gardenId,
      season: new Date().getFullYear(),
      seedId: payload.seedId ?? null,
      cambiumSeedId: payload.cambiumSeedId ?? null,
      companionSeedId: null,
      spacingInches: null,
      quantity: payload.quantity ?? 1,
      plantingDate: payload.plantingDate ?? null,
      cell: payload.cell ?? null,
      point: payload.point ?? null,
      growth: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      _commonName: commonName,
    };
    _addPlanting(optimistic);
    try {
      const result = await api.post<Planting>(`/api/gardens/${gardenId}/beds/${bedId}/plantings`, payload);
      if (!result) throw new Error('No planting returned');
      _removePlanting(tempId, bedId);
      _addPlanting({ ...result, _commonName: commonName });
      seqRef.current += 1;
      setLatestPlacing({ id: result.id, seq: seqRef.current });
    } catch (e) {
      _removePlanting(tempId, bedId);
      setError(e instanceof Error ? e.message : 'Failed to place planting');
    }
  }, [gardenId, _addPlanting, _removePlanting]);

  const deletePlanting = useCallback(async (plantingId: string, bedId: string): Promise<void> => {
    const snapshot = plantingsRef.current;
    _removePlanting(plantingId, bedId);
    try {
      await api.del(`/api/plantings/${plantingId}`);
    } catch (e) {
      syncPlantings(snapshot);
      setError(e instanceof Error ? e.message : 'Failed to remove planting');
    }
  }, [_removePlanting, syncPlantings]);

  const updatePlantingPoint = useCallback(async (
    plantingId: string,
    bedId: string,
    point: { x: number; y: number },
  ): Promise<void> => {
    const snapshot = plantingsRef.current;
    // Optimistic update
    const prev = plantingsRef.current;
    syncPlantings({
      ...prev,
      [bedId]: (prev[bedId] ?? []).map(p =>
        p.id === plantingId ? { ...p, point } : p,
      ),
    });
    try {
      await api.patch(`/api/plantings/${plantingId}`, { point });
    } catch (e) {
      syncPlantings(snapshot);
      setError(e instanceof Error ? e.message : 'Failed to update planting position');
    }
  }, [syncPlantings]);

  return { plantingsByBedId, loading, error, reload, placePlanting, deletePlanting, latestPlacing, updatePlantingPoint };
}

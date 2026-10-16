import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../lib/api';
import { currentSeasonPacific } from '../lib/guideDates';
import type { GrowthStage } from '../lib/growthStages';

export interface PlantingGrowth {
  stagePct: number | null;
  harvestReady: boolean;
  // Never used by the canvas: there is no overdue state (no fading, recolouring
  // or flagging past the window end).
  harvestWindowEnd: string | null;
  indicatorDismissedAt: string | null;
  stage: GrowthStage | null;
  displayedStage: GrowthStage | null;
  anchored: boolean;
}

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
  growth: PlantingGrowth;
  createdAt: string;
  updatedAt: string;
  _commonName?: string; // client-side display label, not from API
}

export interface ArmedSeed {
  source: 'catalogue' | 'personal';
  id: string;
  commonName: string;
  spacingInches: number;
  spacingOnRecord: number | null;   // the seed's real spacing; null if none
  cambiumIdentity: string | null;   // catalogue: its own id; personal: its cambiumSourceId, or null
}

export interface PlacePlantingResult {
  ok: boolean;
  merged?: boolean;
  blocked?: boolean;
  planting?: Planting;
  occupantName?: string;
}

export type PlantingsByBedId = Record<string, Planting[]>;

const EMPTY_GROWTH: PlantingGrowth = {
  stagePct: null,
  harvestReady: false,
  harvestWindowEnd: null,
  indicatorDismissedAt: null,
  stage: null,
  displayedStage: null,
  anchored: false,
};

// season defaults to the current Pacific-year season; pass a past season to
// load that season's plantings with the same code.
export function usePlantings(gardenId: string | null, season: number = currentSeasonPacific()) {
  const [plantingsByBedId, setPlantingsByBedId] = useState<PlantingsByBedId>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [latestPlacing, setLatestPlacing] = useState<{ id: string; seq: number } | null>(null);
  // `${gardenId}:${season}` of the last completed load; lets the canvas tell
  // "loaded" apart from "not fetched yet".
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  // `${gardenId}:${season}` the current error belongs to.
  const [errorKey, setErrorKey] = useState<string | null>(null);
  // Latest load wins: stale responses (season/garden changed mid-fetch, or the
  // id went null) are ignored.
  const requestRef = useRef(0);
  const plantingsRef = useRef<PlantingsByBedId>({});
  const seqRef = useRef(0);

  const syncPlantings = useCallback((next: PlantingsByBedId) => {
    plantingsRef.current = next;
    setPlantingsByBedId(next);
  }, []);

  const reload = useCallback(async () => {
    if (!gardenId) return;
    const req = ++requestRef.current;
    setLoading(true);
    setError(null);
    setErrorKey(null);
    try {
      const res = await api.get<{ data: Planting[] }>(`/api/gardens/${gardenId}/plantings?season=${season}`);
      if (req !== requestRef.current) return;
      const list = res?.data ?? [];
      const byBed: PlantingsByBedId = {};
      for (const p of list) {
        if (!byBed[p.bedId]) byBed[p.bedId] = [];
        byBed[p.bedId].push(p);
      }
      syncPlantings(byBed);
      setLoadedKey(`${gardenId}:${season}`);
    } catch (e) {
      if (req !== requestRef.current) return;
      setError(e instanceof Error ? e.message : 'Failed to load plantings');
      setErrorKey(`${gardenId}:${season}`);
    } finally {
      if (req === requestRef.current) setLoading(false);
    }
  }, [gardenId, season, syncPlantings]);

  useEffect(() => {
    if (!gardenId) {
      requestRef.current += 1;
      setLoading(false);
      setErrorKey(null);
      syncPlantings({});
      return;
    }
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
    // The armed seed's Cambium identity, so the temp marker matches the
    // same-plant check before the server row arrives.
    cambiumIdentity?: string | null,
  ): Promise<PlacePlantingResult> => {
    if (!gardenId) return { ok: false };
    const tempId = `temp-${Date.now()}`;
    // An occupied grid cell either merges into the existing planting or is
    // blocked, so it never gets a second (temp) marker.
    const cellOccupied = payload.cell != null && (plantingsRef.current[bedId] ?? []).some(p =>
      p.cell != null && p.cell.x === payload.cell!.x && p.cell.y === payload.cell!.y,
    );
    const optimistic: Planting = {
      id: tempId,
      bedId,
      gardenId,
      season,
      seedId: payload.seedId ?? null,
      cambiumSeedId: payload.cambiumSeedId ?? null,
      companionSeedId: payload.cambiumSeedId ?? cambiumIdentity ?? null,
      spacingInches: null,
      quantity: payload.quantity ?? 1,
      plantingDate: payload.plantingDate ?? null,
      cell: payload.cell ?? null,
      point: payload.point ?? null,
      growth: EMPTY_GROWTH,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      _commonName: commonName,
    };
    if (!cellOccupied) _addPlanting(optimistic);
    try {
      const response = await api.post<Planting & { merged?: boolean }>(`/api/gardens/${gardenId}/beds/${bedId}/plantings`, payload);
      if (!response) throw new Error('No planting returned');
      const { merged, ...result } = response;
      if (!cellOccupied) _removePlanting(tempId, bedId);
      if (merged) {
        // Swap the existing planting for the returned one; never add a second.
        const prev = plantingsRef.current;
        const list = prev[bedId] ?? [];
        const existing = list.find(p => p.id === result.id);
        const next: Planting = {
          ...result,
          _commonName: existing?._commonName ?? commonName,
          // Keep the local displayedStage: markStagesDisplayed may be ahead
          // of the server row (its PATCH is best-effort).
          growth: existing ? { ...result.growth, displayedStage: existing.growth.displayedStage } : result.growth,
        };
        syncPlantings({
          ...prev,
          [bedId]: existing ? list.map(p => (p.id === result.id ? next : p)) : [...list, next],
        });
        return { ok: true, merged: true, planting: next };
      }
      const created: Planting = { ...result, _commonName: commonName };
      // A racing merge into this new planting may already have added it. A
      // merge can only follow the INSERT, so that entry is at least as fresh:
      // keep it, and never add a second.
      if (!(plantingsRef.current[bedId] ?? []).some(p => p.id === created.id)) {
        _addPlanting(created);
      }
      seqRef.current += 1;
      setLatestPlacing({ id: result.id, seq: seqRef.current });
      return { ok: true, merged: false, planting: created };
    } catch (e) {
      if (!cellOccupied) _removePlanting(tempId, bedId);
      if (e instanceof api.ApiError && e.status === 409) {
        const body = e.body as { code?: string; occupant?: { commonName?: string | null } } | null | undefined;
        if (body?.code === 'CELL_OCCUPIED') {
          return { ok: false, blocked: true, occupantName: body.occupant?.commonName ?? 'a plant' };
        }
      }
      setError(e instanceof Error ? e.message : 'Failed to place planting');
      return { ok: false };
    }
  }, [gardenId, season, _addPlanting, _removePlanting, syncPlantings]);

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

  // Per planting: the latest quantity request, the last server-confirmed
  // quantity (or the value before the first request) and requests in flight.
  const qtyReqRef = useRef(new Map<string, {
    seq: number; confirmed: number; confirmedSeq: number; inFlight: number; latestFailed: boolean;
  }>());

  // "Plants here": optimistic, like updatePlantingPoint, but rejects when the
  // latest request fails so the caller can report it (a superseded request
  // resolves quietly). If the latest request failed, the quantity reverts to
  // the last confirmed value once no request for it is still in flight.
  const updatePlantingQuantity = useCallback(async (
    plantingId: string,
    bedId: string,
    quantity: number,
  ): Promise<void> => {
    const prev = plantingsRef.current;
    const current = (prev[bedId] ?? []).find(p => p.id === plantingId);
    const entry = qtyReqRef.current.get(plantingId)
      ?? { seq: 0, confirmed: current?.quantity ?? quantity, confirmedSeq: 0, inFlight: 0, latestFailed: false };
    entry.seq += 1;
    entry.inFlight += 1;
    entry.latestFailed = false;
    qtyReqRef.current.set(plantingId, entry);
    const mySeq = entry.seq;
    syncPlantings({
      ...prev,
      [bedId]: (prev[bedId] ?? []).map(p =>
        p.id === plantingId ? { ...p, quantity } : p,
      ),
    });
    try {
      await api.patch(`/api/plantings/${plantingId}`, { quantity });
      if (mySeq > entry.confirmedSeq) {
        entry.confirmed = quantity;
        entry.confirmedSeq = mySeq;
      }
    } catch (e) {
      if (mySeq === entry.seq) {
        entry.latestFailed = true;
        throw e;
      }
    } finally {
      entry.inFlight -= 1;
      if (entry.inFlight === 0) {
        if (entry.latestFailed) {
          const now = plantingsRef.current;
          syncPlantings({
            ...now,
            [bedId]: (now[bedId] ?? []).map(p =>
              p.id === plantingId ? { ...p, quantity: entry.confirmed } : p,
            ),
          });
        }
        if (qtyReqRef.current.get(plantingId) === entry) qtyReqRef.current.delete(plantingId);
      }
    }
  }, [syncPlantings]);

  // Records that the canvas has shown these plantings' current stage, so the
  // entrance/pulse does not repeat. Local state updates first; the PATCH is
  // best-effort and failures are ignored.
  const markStagesDisplayed = useCallback((plantingIds: string[]) => {
    if (!gardenId || plantingIds.length === 0) return;
    const ids = new Set(plantingIds);
    const prev = plantingsRef.current;
    const next: PlantingsByBedId = {};
    for (const [bedId, list] of Object.entries(prev)) {
      next[bedId] = list.map(p =>
        ids.has(p.id) ? { ...p, growth: { ...p.growth, displayedStage: p.growth.stage } } : p,
      );
    }
    syncPlantings(next);
    for (let i = 0; i < plantingIds.length; i += 500) {
      api.patch(`/api/gardens/${gardenId}/plantings/displayed-stage`, {
        plantingIds: plantingIds.slice(i, i + 500),
      }).catch(() => {});
    }
  }, [gardenId, syncPlantings]);

  // "Mark as harvested": dismisses the harvest-ready indicator, then swaps in
  // the returned planting (indicatorDismissedAt set). Throws on failure so the
  // caller can show its own error; local state is untouched until success.
  const dismissIndicator = useCallback(async (plantingId: string, bedId: string): Promise<void> => {
    const result = await api.patch<Planting>(`/api/plantings/${plantingId}`, { dismissIndicator: true });
    if (!result) throw new Error('No planting returned');
    const prev = plantingsRef.current;
    syncPlantings({
      ...prev,
      [bedId]: (prev[bedId] ?? []).map(p =>
        // Keep the local displayedStage: markStagesDisplayed may be ahead of
        // the server row (its PATCH is best-effort).
        p.id === plantingId
          ? { ...result, growth: { ...result.growth, displayedStage: p.growth.displayedStage }, _commonName: p._commonName }
          : p,
      ),
    });
  }, [syncPlantings]);

  return {
    plantingsByBedId, loading, error, errorKey, reload, placePlanting, deletePlanting, latestPlacing,
    updatePlantingPoint, updatePlantingQuantity, season, loadedKey, markStagesDisplayed, dismissIndicator,
  };
}

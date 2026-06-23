import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../lib/api';

export interface BedGrid {
  x: number;
  y: number;
  cols: number;
  rows: number;
}

export interface BedFreeform {
  points: number[];
  closed: boolean;
}

export interface Bed {
  id: string;
  gardenId: string;
  season: number;
  type: 'grid' | 'freeform';
  label: string;
  grid: BedGrid | null;
  freeform: BedFreeform | null;
  plantingCount: number;
  createdAt: string;
  updatedAt: string;
}

export type CreateBedPayload =
  | { type: 'grid'; label: string; grid: BedGrid }
  | { type: 'freeform'; label: string; freeform: BedFreeform };

export type UpdateBedPayload =
  | { label: string }
  | { grid: BedGrid }
  | { freeform: BedFreeform };

export interface Garden {
  id: string;
  name: string;
  style: string;
  growingMethod: string;
  zone: string;
  zoneLocationLabel: string | null;
  beds: Bed[];
}

export function useGarden(id: string | null) {
  const [garden, setGarden] = useState<Garden | null>(null);
  const [beds, setBeds] = useState<Bed[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const bedsRef = useRef<Bed[]>([]);

  const syncBeds = useCallback((next: Bed[]) => {
    bedsRef.current = next;
    setBeds(next);
  }, []);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<Garden>(`/api/gardens/${id}`);
      if (res) {
        setGarden(res);
        syncBeds(res.beds);
      } else {
        setGarden(null);
        syncBeds([]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load garden');
    } finally {
      setLoading(false);
    }
  }, [id, syncBeds]);

  useEffect(() => {
    if (!id) {
      setGarden(null);
      syncBeds([]);
      return;
    }
    load();
  }, [id, load, syncBeds]);

  const createBed = useCallback(async (payload: CreateBedPayload): Promise<Bed | null> => {
    if (!id) return null;
    setMutationError(null);
    const tempId = `temp-${Date.now()}`;
    const optimistic: Bed = {
      id: tempId,
      gardenId: id,
      season: new Date().getFullYear(),
      type: payload.type,
      label: payload.label,
      grid: payload.type === 'grid' ? payload.grid : null,
      freeform: payload.type === 'freeform' ? payload.freeform : null,
      plantingCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    syncBeds([...bedsRef.current, optimistic]);
    try {
      const bed = await api.post<Bed>(`/api/gardens/${id}/beds`, payload);
      if (!bed) throw new Error('No bed returned');
      syncBeds(bedsRef.current.map(b => b.id === tempId ? bed : b));
      return bed;
    } catch (e) {
      syncBeds(bedsRef.current.filter(b => b.id !== tempId));
      setMutationError(e instanceof Error ? e.message : 'Failed to create bed');
      return null;
    }
  }, [id, syncBeds]);

  const updateBed = useCallback(async (bedId: string, payload: UpdateBedPayload): Promise<void> => {
    if (!id) return;
    setMutationError(null);
    const prev = bedsRef.current.find(b => b.id === bedId);
    if (!prev) return;
    const optimistic: Bed = {
      ...prev,
      ...('label' in payload ? { label: payload.label } : {}),
      ...('grid' in payload ? { grid: payload.grid } : {}),
      ...('freeform' in payload ? { freeform: payload.freeform } : {}),
    };
    syncBeds(bedsRef.current.map(b => b.id === bedId ? optimistic : b));
    try {
      const updated = await api.patch<Bed>(`/api/gardens/${id}/beds/${bedId}`, payload);
      if (!updated) throw new Error('No bed returned from update');
      syncBeds(bedsRef.current.map(b => b.id === bedId ? updated : b));
    } catch (e) {
      syncBeds(bedsRef.current.map(b => b.id === bedId ? prev : b));
      setMutationError(e instanceof Error ? e.message : 'Failed to update bed');
    }
  }, [id, syncBeds]);

  const deleteBed = useCallback(async (bedId: string): Promise<void> => {
    if (!id) return;
    setMutationError(null);
    const prev = bedsRef.current.find(b => b.id === bedId);
    if (!prev) return;
    const prevAll = bedsRef.current;
    syncBeds(bedsRef.current.filter(b => b.id !== bedId));
    try {
      await api.del(`/api/gardens/${id}/beds/${bedId}`);
    } catch (e) {
      syncBeds(prevAll);
      setMutationError(e instanceof Error ? e.message : 'Failed to delete bed');
    }
  }, [id, syncBeds]);

  return { garden, beds, loading, error, mutationError, reload: load, createBed, updateBed, deleteBed };
}

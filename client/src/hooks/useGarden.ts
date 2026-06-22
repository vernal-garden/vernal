import { useCallback, useEffect, useState } from 'react';
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
  createdAt: string;
  updatedAt: string;
}

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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<Garden>(`/api/gardens/${id}`);
      setGarden(res ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load garden');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (!id) {
      setGarden(null);
      return;
    }
    load();
  }, [id, load]);

  return { garden, loading, error, reload: load };
}

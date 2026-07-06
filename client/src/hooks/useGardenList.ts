import { useCallback, useEffect, useState } from 'react';
import * as api from '../lib/api';

export interface GardenSummary {
  id: string;
  name: string;
  style: string;
  growingMethod: string;
  zone: string;
  thumbnailUrl: string | null;
  lastAccessedAt: string;
  activePlantingCount: number;
  harvestableCount: number;
  hasCompanionWarnings: boolean;
}

export function useGardenList() {
  const [gardens, setGardens] = useState<GardenSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<{ data: GardenSummary[] }>('/api/gardens');
      setGardens(res?.data ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load gardens');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return { gardens, loading, error, reload: load };
}

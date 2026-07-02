// client/src/hooks/useFamilies.ts
import { useEffect, useState } from 'react';
import { get } from '../lib/api';
import type { FamilyEntry } from '../types/catalogue';

// Module-level cache — survives re-renders, resets on full page reload.
let cache: FamilyEntry[] | null = null;
let inflight: Promise<FamilyEntry[]> | null = null;

async function fetchFamilies(): Promise<FamilyEntry[]> {
  if (cache) return cache;
  if (!inflight) {
    inflight = get<{ data: FamilyEntry[] }>('/api/catalogue/families').then((res) => {
      cache = res?.data ?? [];
      return cache;
    }).finally(() => {
      inflight = null;
    }) as Promise<FamilyEntry[]>;
  }
  return inflight;
}

export function useFamilies() {
  const [families, setFamilies] = useState<FamilyEntry[]>(cache ?? []);
  const [loading, setLoading] = useState(cache === null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (cache) return;
    let cancelled = false;
    fetchFamilies()
      .then((data) => { if (!cancelled) { setFamilies(data); setLoading(false); } })
      .catch(() => { if (!cancelled) { setError('Failed to load families'); setLoading(false); } });
    return () => { cancelled = true; };
  }, []);

  return { families, loading, error };
}

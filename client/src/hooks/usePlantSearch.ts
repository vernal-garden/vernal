import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import * as api from '../lib/api';

export interface SeedResult {
  id: string;
  commonName: string;
  spacingInches: number | null;
  source: 'catalogue' | 'personal';
}

interface ApiSeed {
  id: string;
  commonName: string;
  spacingInches?: number | null;
}

export function usePlantSearch(query: string) {
  const { isAccount } = useAuth();
  const [catalogue, setCatalogue] = useState<SeedResult[]>([]);
  const [personal, setPersonal] = useState<SeedResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const search = useCallback(async (q: string) => {
    setLoading(true);
    setError(null);
    try {
      const catRes = await api.get<{ data: ApiSeed[] }>(
        `/api/catalogue/seeds?q=${encodeURIComponent(q)}&limit=20`,
      );
      setCatalogue(
        (catRes?.data ?? []).map(s => ({
          id: s.id,
          commonName: s.commonName,
          spacingInches: s.spacingInches ?? null,
          source: 'catalogue' as const,
        })),
      );

      if (isAccount) {
        const perRes = await api.get<{ data: ApiSeed[] }>(
          `/api/seeds?q=${encodeURIComponent(q)}&limit=20`,
        );
        setPersonal(
          (perRes?.data ?? []).map(s => ({
            id: s.id,
            commonName: s.commonName,
            spacingInches: s.spacingInches ?? null,
            source: 'personal' as const,
          })),
        );
      } else {
        setPersonal([]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Search failed');
    } finally {
      setLoading(false);
    }
  }, [isAccount]);

  useEffect(() => {
    if (query.length < 2) {
      setCatalogue([]);
      setPersonal([]);
      setLoading(false);
      if (timerRef.current) clearTimeout(timerRef.current);
      return;
    }
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => search(query), 300);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [query, search]);

  return { catalogue, personal, loading, error };
}

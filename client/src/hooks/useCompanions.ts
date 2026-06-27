import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../lib/api';

export interface CompanionEntry {
  id: string;
  slug: string;
  commonName: string;
  relationship: 'beneficial' | 'antagonistic' | 'neutral';
}

export function useCompanions(seedIds: Set<string>) {
  // Cache: cambium seed id → CompanionEntry[]
  const cacheRef = useRef<Map<string, CompanionEntry[]>>(new Map());
  // Tracks which IDs are currently being fetched
  const fetchingRef = useRef<Set<string>>(new Set());
  // Bump to trigger re-renders when cache updates
  const [cacheVersion, setCacheVersion] = useState(0);

  const fetchOne = useCallback(async (id: string) => {
    if (cacheRef.current.has(id) || fetchingRef.current.has(id)) return;
    fetchingRef.current.add(id);
    try {
      const res = await api.get<{ data: CompanionEntry[] }>(
        `/api/catalogue/seeds/${encodeURIComponent(id)}/companions`,
      );
      cacheRef.current.set(id, res?.data ?? []);
      setCacheVersion(v => v + 1);
    } catch {
      // On error, store empty array to avoid retrying
      cacheRef.current.set(id, []);
    } finally {
      fetchingRef.current.delete(id);
    }
  }, []);

  // Called to trigger fetches for IDs not yet in cache
  const ensureLoaded = useCallback(
    (ids: string[]) => {
      for (const id of ids) {
        if (!cacheRef.current.has(id)) {
          void fetchOne(id);
        }
      }
    },
    [fetchOne],
  );

  // Synchronous lookup: checks a's list for b, then b's list for a
  const relationshipBetween = useCallback(
    (aId: string, bId: string): 'beneficial' | 'antagonistic' | null => {
      const aList = cacheRef.current.get(aId);
      if (aList) {
        const entry = aList.find(e => e.id === bId);
        if (entry) return entry.relationship === 'neutral' ? null : entry.relationship;
      }
      const bList = cacheRef.current.get(bId);
      if (bList) {
        const entry = bList.find(e => e.id === aId);
        if (entry) return entry.relationship === 'neutral' ? null : entry.relationship;
      }
      return null;
    },
    [], // reads from cacheRef (stable ref), no deps needed
  );

  // Eager fetch whenever the set of seed IDs changes
  useEffect(() => {
    for (const id of seedIds) {
      void fetchOne(id);
    }
  }, [seedIds, fetchOne]);

  return { relationshipBetween, ensureLoaded, cacheVersion };
}

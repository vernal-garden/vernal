import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import * as api from '../lib/api';
import { fetchAllPages } from '../lib/fetchAllPages';
import type { PlantingsByBedId } from './usePlantings';

export interface PickerSeedEntry {
  source: 'catalogue' | 'personal';
  id: string;
  commonName: string;
  spacingInches: number | null;
  companionSeedId: string | null;
}

interface ApiSeed {
  id: string;
  commonName: string;
  spacingInches?: number | null;
  cambiumSourceId?: string | null;
  ratingCount?: number;
}

// api.get resolves undefined on an empty body; treat that as an empty page.
const EMPTY_PAGE = { data: [] as ApiSeed[], total: 0 };

function toCatalogueEntry(s: ApiSeed): PickerSeedEntry {
  return {
    source: 'catalogue',
    id: String(s.id),
    commonName: s.commonName,
    spacingInches: s.spacingInches ?? null,
    companionSeedId: String(s.id),
  };
}

export interface PickerDefaults {
  mySeeds: PickerSeedEntry[];
  popular: PickerSeedEntry[];
  allPlants: PickerSeedEntry[];
  recentlyUsed: PickerSeedEntry[];
  loading: boolean;
}

export function usePickerDefaults(_gardenId: string | null, plantingsByBedId: PlantingsByBedId): PickerDefaults {
  const { isAccount } = useAuth();
  const [mySeeds, setMySeeds] = useState<PickerSeedEntry[]>([]);
  const [popular, setPopular] = useState<PickerSeedEntry[]>([]);
  const [allPlants, setAllPlants] = useState<PickerSeedEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    const fetches: Promise<void>[] = [
      api.get<{ data: ApiSeed[]; total: number | string }>('/api/catalogue/seeds?sort=popular&limit=10')
        .then(res => {
          if (!cancelled) {
            setPopular((res?.data ?? []).filter(s => (s.ratingCount ?? 0) > 0).map(toCatalogueEntry));
          }
        })
        .catch(() => { if (!cancelled) setPopular([]); }),
      fetchAllPages<ApiSeed>(
        (offset, limit) => api.get<{ data: ApiSeed[]; total: number | string }>(`/api/catalogue/seeds?limit=${limit}&offset=${offset}`).then(res => res ?? EMPTY_PAGE),
        50,
      )
        .then(rows => { if (!cancelled) setAllPlants(rows.map(toCatalogueEntry)); })
        .catch(() => { if (!cancelled) setAllPlants([]); }),
    ];

    if (isAccount) {
      fetches.push(
        fetchAllPages<ApiSeed>(
          (offset, limit) => api.get<{ data: ApiSeed[]; total: number | string }>(`/api/seeds?limit=${limit}&offset=${offset}`).then(res => res ?? EMPTY_PAGE),
          100,
        )
          .then(rows => {
            if (!cancelled) {
              setMySeeds(rows.map(s => ({
                source: 'personal' as const,
                id: String(s.id),
                commonName: s.commonName,
                spacingInches: s.spacingInches ?? null,
                companionSeedId: s.cambiumSourceId ?? null,
              })));
            }
          })
          .catch(() => { if (!cancelled) setMySeeds([]); }),
      );
    } else {
      setMySeeds([]);
    }

    Promise.allSettled(fetches).then(() => {
      if (!cancelled) setLoading(false);
    });

    return () => { cancelled = true; };
  }, [isAccount]);

  const recentlyUsed = useMemo<PickerSeedEntry[]>(() => {
    const all = Object.values(plantingsByBedId).flat();
    all.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const seen = new Set<string>();
    const result: PickerSeedEntry[] = [];

    for (const p of all) {
      if (result.length >= 8) break;
      const source: 'catalogue' | 'personal' | null = p.seedId ? 'personal' : p.cambiumSeedId ? 'catalogue' : null;
      const id = p.seedId ?? p.cambiumSeedId;
      if (!source || !id) continue;
      const key = `${source}:${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        source,
        id,
        commonName: p.commonName ?? p._commonName ?? id,
        spacingInches: p.spacingInches ?? null,
        companionSeedId: p.companionSeedId,
      });
    }

    return result;
  }, [plantingsByBedId]);

  return { mySeeds, popular, allPlants, recentlyUsed, loading };
}

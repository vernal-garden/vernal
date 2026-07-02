// client/src/hooks/useCatalogueBrowse.ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { get } from '../lib/api';
import type { BrowseCard, CommunityCard, PersonalCard } from '../types/catalogue';

export type CatalogueSource = 'cambium' | 'mine' | 'all';

interface BrowseParams {
  source: CatalogueSource;
  q: string;
  family: string;
}

interface BrowseState {
  cards: BrowseCard[];
  total: number;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  error: string | null;
}

const PAGE_SIZE_COMMUNITY = 20;
const PAGE_SIZE_PERSONAL  = 50;
const ALL_PERSONAL_PREFETCH_LIMIT = 100;

// Raw API response shapes
interface CommunityApiItem {
  id: string; commonName: string; scientificName: string | null;
  plantFamily: string | null; illustrationKey: string | null;
  aggregateRating: number | null; ratingCount: number;
}
interface PersonalApiItem {
  id: string; commonName: string; scientificName: string | null;
  plantFamily: string | null; illustrationKey: string | null;
  userRating: number | null; isFavourite: boolean;
  origin: string; contributionStatus: string; cambiumSourceId: string | null;
}

function toCommunityCard(item: CommunityApiItem): CommunityCard {
  return { kind: 'community', id: item.id, commonName: item.commonName,
    scientificName: item.scientificName, plantFamily: item.plantFamily,
    illustrationKey: item.illustrationKey, aggregateRating: item.aggregateRating,
    ratingCount: item.ratingCount };
}

function toPersonalCard(item: PersonalApiItem): PersonalCard {
  return { kind: 'personal', id: item.id, commonName: item.commonName,
    scientificName: item.scientificName, plantFamily: item.plantFamily,
    illustrationKey: item.illustrationKey, userRating: item.userRating,
    isFavourite: item.isFavourite, origin: item.origin,
    contributionStatus: item.contributionStatus, cambiumSourceId: item.cambiumSourceId };
}

function buildCommunityUrl(q: string, family: string, offset: number): string {
  const params = new URLSearchParams();
  if (q.trim().length >= 2) params.set('q', q.trim());
  if (family) params.set('family', family);
  params.set('limit', String(PAGE_SIZE_COMMUNITY));
  params.set('offset', String(offset));
  return `/api/catalogue/seeds?${params}`;
}

function buildPersonalUrl(q: string, family: string, offset: number, limit: number): string {
  const params = new URLSearchParams();
  if (q.trim().length >= 2) params.set('q', q.trim());
  if (family) params.set('family', family);
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  return `/api/seeds?${params}`;
}

export function useCatalogueBrowse({ source, q, family }: BrowseParams) {
  const [state, setState] = useState<BrowseState>({
    cards: [], total: 0, loading: true, loadingMore: false, hasMore: false, error: null,
  });

  // Community offset for pagination (also used in 'all' mode for community portion)
  const communityOffsetRef = useRef(0);
  // In 'all' mode, personal cards are fetched once and stored here for dedup
  const personalCardsRef = useRef<PersonalCard[]>([]);
  // Track current params to reset pagination on change
  const paramsRef = useRef({ source, q, family });
  // Debounce timer
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const doFetch = useCallback(async (
    fetchSource: CatalogueSource,
    fetchQ: string,
    fetchFamily: string,
    fetchCommunityOffset: number,
    isLoadMore: boolean,
    personalCards: PersonalCard[],
  ) => {
    setState(prev => ({
      ...prev,
      loading: !isLoadMore,
      loadingMore: isLoadMore,
      error: null,
    }));

    try {
      if (fetchSource === 'cambium') {
        const res = await get<{ data: CommunityApiItem[]; total: number; limit: number; offset: number }>(
          buildCommunityUrl(fetchQ, fetchFamily, fetchCommunityOffset),
        );
        const newCards = (res?.data ?? []).map(toCommunityCard);
        setState(prev => ({
          cards: isLoadMore ? [...prev.cards, ...newCards] : newCards,
          total: res?.total ?? 0,
          loading: false,
          loadingMore: false,
          hasMore: fetchCommunityOffset + newCards.length < (res?.total ?? 0),
          error: null,
        }));
      } else if (fetchSource === 'mine') {
        const res = await get<{ data: PersonalApiItem[]; total: number }>(
          buildPersonalUrl(fetchQ, fetchFamily, fetchCommunityOffset, PAGE_SIZE_PERSONAL),
        );
        const newCards = (res?.data ?? []).map(toPersonalCard);
        setState(prev => ({
          cards: isLoadMore ? [...prev.cards, ...newCards] : newCards,
          total: res?.total ?? 0,
          loading: false,
          loadingMore: false,
          hasMore: fetchCommunityOffset + newCards.length < (res?.total ?? 0),
          error: null,
        }));
      } else {
        // 'all': personal (once, large limit) + paginated community (deduped)
        let allPersonal = personalCards;
        if (!isLoadMore) {
          const pRes = await get<{ data: PersonalApiItem[] }>(
            buildPersonalUrl(fetchQ, fetchFamily, 0, ALL_PERSONAL_PREFETCH_LIMIT),
          );
          allPersonal = (pRes?.data ?? []).map(toPersonalCard);
          personalCardsRef.current = allPersonal;
        }

        const coveredCambiumIds = new Set(
          allPersonal.map(p => p.cambiumSourceId).filter((id): id is string => id !== null),
        );

        const cRes = await get<{ data: CommunityApiItem[]; total: number }>(
          buildCommunityUrl(fetchQ, fetchFamily, fetchCommunityOffset),
        );
        const communityRaw = (cRes?.data ?? []).filter(c => !coveredCambiumIds.has(c.id));
        const communityCards = communityRaw.map(toCommunityCard);
        const communityTotal = cRes?.total ?? 0;
        // Approximation: subtracts all personal overlaps from total regardless of query match.
        const dedupedCommunityTotal = Math.max(0, communityTotal - coveredCambiumIds.size);

        setState(prev => ({
          cards: isLoadMore ? [...prev.cards, ...communityCards] : [...allPersonal, ...communityCards],
          total: allPersonal.length + dedupedCommunityTotal,
          loading: false,
          loadingMore: false,
          hasMore: fetchCommunityOffset + (cRes?.data?.length ?? 0) < communityTotal,
          error: null,
        }));
      }
    } catch {
      setState(prev => ({ ...prev, loading: false, loadingMore: false, error: 'Failed to load seeds' }));
    }
  // state.cards is referenced in the loadMore path but shouldn't be a dep
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reset + fetch on params change (debounced for q)
  useEffect(() => {
    paramsRef.current = { source, q, family };
    communityOffsetRef.current = 0;
    personalCardsRef.current = [];

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      doFetch(source, q, family, 0, false, []);
    }, 300);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [source, q, family, doFetch]);

  const loadMore = useCallback(() => {
    if (state.loadingMore || !state.hasMore) return;
    const nextOffset = communityOffsetRef.current + PAGE_SIZE_COMMUNITY;
    communityOffsetRef.current = nextOffset;
    const { source: s, q: curQ, family: f } = paramsRef.current;
    doFetch(s, curQ, f, nextOffset, true, personalCardsRef.current);
  }, [state.loadingMore, state.hasMore, doFetch]);

  const refetch = useCallback(() => {
    communityOffsetRef.current = 0;
    personalCardsRef.current = [];
    const { source: s, q: curQ, family: f } = paramsRef.current;
    doFetch(s, curQ, f, 0, false, []);
  }, [doFetch]);

  return { ...state, loadMore, refetch };
}

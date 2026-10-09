// client/src/hooks/useSubscription.ts
import { useCallback, useEffect, useState } from 'react';
import { get } from '../lib/api';

export interface SubscriptionData {
  tier: 'free' | 'supporter';
  isSupporter: boolean;
  interval: 'monthly' | 'annual' | 'lifetime' | null;
  periodEnd: string | null;
  cancelledAt: string | null;
  hasCustomer: boolean;
}

export function useSubscription() {
  const [data, setData] = useState<SubscriptionData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await get<SubscriptionData>('/api/subscription');
      setData(res ?? null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load subscription');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return { data, loading, error, reload: load };
}

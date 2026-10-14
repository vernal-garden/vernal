// client/src/hooks/useWeather.ts
import { useCallback, useEffect, useState } from 'react';
import { get, patch, del, ApiError } from '../lib/api';
import type { UnitSystem } from '../lib/units';
import type { WeatherInsight } from '../types/weather';

// Mirrors the server's LOCATION_NOT_SET sentinel (src/lib/constants.ts).
const LOCATION_NOT_SET = 'Not set';

export interface WeatherConnection {
  id: string;
  provider: string;
  stationId: string | null;
  isPrimary: boolean;
  lastSuccessfulSync: string | null;
  createdAt: string;
}

export interface CurrentReading {
  readingTimestamp: string;
  temperature: number | null;
  humidity: number | null;
  windSpeed: number | null;
  windDirection: string | null;
  precipitationToday: number | null;
  uvIndex: number | null;
  pressure: number | null;
  source: 'pws_tempest' | 'public_weather';
  cached: boolean;
}

export interface HistoryPoint {
  date: string;
  tempMaxC: number | null;
  tempMinC: number | null;
  precipMm: number | null;
}

export type WeatherErrorKind = 'location_not_set' | 'unavailable' | 'other';

function classifyError(e: unknown): WeatherErrorKind {
  if (e instanceof ApiError && e.status === 422) return 'location_not_set';
  if (e instanceof ApiError && e.status === 503) return 'unavailable';
  return 'other';
}

export function useWeather() {
  const [connections, setConnections] = useState<WeatherConnection[]>([]);
  const [current, setCurrent] = useState<CurrentReading | null>(null);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [insights, setInsights] = useState<WeatherInsight[]>([]);
  const [units, setUnitsState] = useState<UnitSystem>('imperial');
  const [locationLabel, setLocationLabel] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<WeatherErrorKind | null>(null);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);

  const loadConnections = useCallback(async () => {
    try {
      const res = await get<{ data: WeatherConnection[] }>('/api/weather/connections');
      setConnections(res?.data ?? []);
    } catch {
      setConnections([]);
    }
  }, []);

  const loadCurrent = useCallback(async () => {
    try {
      const res = await get<CurrentReading>('/api/weather/current');
      setCurrent(res ?? null);
      setError(null);
    } catch (e) {
      setCurrent(null);
      setError(classifyError(e));
    }
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      const res = await get<{ data: HistoryPoint[]; insights?: WeatherInsight[] }>('/api/weather/history');
      setHistory(res?.data ?? []);
      setInsights(res?.insights ?? []);
    } catch {
      setHistory([]);
      setInsights([]);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    await Promise.all([
      get<{ data: { preferences?: { units?: UnitSystem }; zoneLocationLabel?: string | null } }>('/api/me')
        .then((res) => {
          setUnitsState(res?.data.preferences?.units ?? 'imperial');
          const label = res?.data.zoneLocationLabel?.trim();
          setLocationLabel(label && label !== LOCATION_NOT_SET ? label : null);
        })
        .catch(() => {}),
      loadConnections(),
      loadCurrent(),
      loadHistory(),
    ]);
    setLoading(false);
  }, [loadConnections, loadCurrent, loadHistory]);

  useEffect(() => {
    load();
  }, [load]);

  const setUnits = useCallback(
    (next: UnitSystem) => {
      const prev = units;
      setUnitsState(next);
      patch('/api/me/preferences', { units: next }).catch(() => setUnitsState(prev));
    },
    [units],
  );

  const disconnect = useCallback(
    async (connectionId: string) => {
      setDisconnectError(null);
      try {
        await del(`/api/weather/connections/${connectionId}`);
        await Promise.all([loadConnections(), loadCurrent()]);
      } catch (e) {
        setDisconnectError(e instanceof Error ? e.message : 'Failed to disconnect');
      }
    },
    [loadConnections, loadCurrent],
  );

  return {
    connections,
    current,
    history,
    insights,
    units,
    locationLabel,
    loading,
    error,
    disconnectError,
    setUnits,
    reload: load,
    refreshCurrent: loadCurrent,
    disconnect,
  };
}

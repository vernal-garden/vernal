// client/src/pages/WeatherPage.tsx
import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import UpgradePrompt from '../components/UpgradePrompt';
import { useWeather } from '../hooks/useWeather';
import CurrentConditions from '../components/weather/CurrentConditions';
import HistoryChart from '../components/weather/HistoryChart';
import GrowingInsights from '../components/weather/GrowingInsights';
import WeatherSetupCard from '../components/weather/WeatherSetupCard';

function relativeSync(iso: string | null): string {
  if (!iso) return 'Never';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min${mins === 1 ? '' : 's'} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

const toggleBtnSt = (active: boolean): React.CSSProperties => ({
  padding: '4px 10px',
  fontSize: 12,
  fontFamily: 'var(--font-ui)',
  border: '1px solid var(--c-border)',
  background: active ? 'var(--c-primary)' : 'transparent',
  color: active ? 'var(--c-text-on-primary)' : 'var(--c-text-2)',
  cursor: 'pointer',
});

export default function WeatherPage() {
  const { account } = useAuth();
  const isSupporter = account?.subscriptionTier === 'supporter';

  const { connections, current, history, units, loading, error, setUnits, refreshCurrent, reload, disconnect } =
    useWeather();

  const [refreshing, setRefreshing] = useState(false);

  if (!isSupporter) {
    return (
      <div style={{ padding: 'var(--sp-6)' }}>
        <UpgradePrompt gateKey="weather" />
      </div>
    );
  }

  if (loading) {
    return (
      <div style={{ padding: 'var(--sp-6)', fontFamily: 'var(--font-ui)', color: 'var(--c-text-3)' }}>
        Loading…
      </div>
    );
  }

  const showSetup = error === 'location_not_set' && connections.length === 0;

  async function handleRefresh() {
    setRefreshing(true);
    await refreshCurrent();
    setRefreshing(false);
  }

  return (
    <div style={{ maxWidth: 680, margin: '0 auto', padding: 'var(--sp-5)' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 'var(--sp-4)',
        }}
      >
        <h1 style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 24, color: 'var(--c-text)' }}>
          Weather
        </h1>
        {!showSetup && (
          <div style={{ display: 'flex' }}>
            <button
              onClick={() => setUnits('imperial')}
              style={{ ...toggleBtnSt(units === 'imperial'), borderRadius: 'var(--r-md) 0 0 var(--r-md)' }}
            >
              °F
            </button>
            <button
              onClick={() => setUnits('metric')}
              style={{
                ...toggleBtnSt(units === 'metric'),
                borderRadius: '0 var(--r-md) var(--r-md) 0',
                borderLeft: 'none',
              }}
            >
              °C
            </button>
          </div>
        )}
      </div>

      {showSetup && (
        <WeatherSetupCard error={error} units={units} onConnected={reload} onTryLocalWeather={refreshCurrent} />
      )}

      {!showSetup && current && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-5)' }}>
          <CurrentConditions reading={current} units={units} onRefresh={handleRefresh} refreshing={refreshing} />
          <HistoryChart history={history} units={units} />
          <GrowingInsights history={history} units={units} />
        </div>
      )}

      {!showSetup && !current && error && (
        <div
          style={{
            padding: 'var(--sp-5)',
            textAlign: 'center',
            fontFamily: 'var(--font-ui)',
            fontSize: 14,
            color: 'var(--c-text-2)',
          }}
        >
          <p style={{ margin: '0 0 var(--sp-3)' }}>Weather data unavailable — try again.</p>
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            style={{
              padding: '8px 20px',
              fontSize: 13,
              fontFamily: 'var(--font-ui)',
              border: 'none',
              borderRadius: 'var(--r-md)',
              background: 'var(--c-primary)',
              color: 'var(--c-text-on-primary)',
              cursor: 'pointer',
            }}
          >
            {refreshing ? 'Retrying…' : 'Retry'}
          </button>
        </div>
      )}

      {!showSetup && connections.length > 0 && (
        <div style={{ marginTop: 'var(--sp-6)', borderTop: '1px solid var(--c-border-subtle)', paddingTop: 'var(--sp-4)' }}>
          <h3
            style={{
              margin: '0 0 var(--sp-3)',
              fontFamily: 'var(--font-display)',
              fontSize: 15,
              color: 'var(--c-text)',
            }}
          >
            Manage connections
          </h3>
          {connections.map((c) => (
            <div
              key={c.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: 'var(--sp-3)',
                border: '1px solid var(--c-border)',
                borderRadius: 'var(--r-md)',
                marginBottom: 'var(--sp-2)',
              }}
            >
              <div style={{ fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--c-text-2)' }}>
                <div style={{ fontWeight: 600, color: 'var(--c-text)' }}>
                  {c.provider === 'pws_tempest' ? 'Tempest WeatherFlow' : c.provider}
                  {c.stationId ? ` · Station ${c.stationId}` : ''}
                </div>
                <div style={{ fontSize: 12, color: 'var(--c-text-3)' }}>
                  Last sync: {relativeSync(c.lastSuccessfulSync)}
                </div>
              </div>
              <button
                onClick={() => disconnect(c.id)}
                style={{
                  padding: '6px 14px',
                  fontSize: 12,
                  fontFamily: 'var(--font-ui)',
                  border: '1px solid var(--c-danger)',
                  borderRadius: 'var(--r-md)',
                  background: 'transparent',
                  color: 'var(--c-danger)',
                  cursor: 'pointer',
                }}
              >
                Disconnect
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

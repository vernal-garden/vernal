import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import type { UnitSystem } from '../../lib/units';
import TempestConnectForm from './TempestConnectForm';
import { PROVIDERS } from './providers';
import type { WeatherErrorKind } from '../../hooks/useWeather';

const cardSt: React.CSSProperties = {
  border: '1px solid var(--c-border)',
  borderRadius: 'var(--r-lg)',
  padding: 'var(--sp-5)',
  background: 'var(--c-surface)',
  cursor: 'pointer',
};

interface Props {
  error: WeatherErrorKind | null;
  units: UnitSystem;
  onConnected: () => void;
  onTryLocalWeather: () => Promise<void>;
}

export default function WeatherSetupCard({ error, units, onConnected, onTryLocalWeather }: Props) {
  const [mode, setMode] = useState<'choose' | 'connect-tempest'>('choose');
  const [triedLocal, setTriedLocal] = useState(false);
  const [tryingLocal, setTryingLocal] = useState(false);

  async function handleTryLocal() {
    setTryingLocal(true);
    setTriedLocal(true);
    await onTryLocalWeather();
    setTryingLocal(false);
  }

  if (mode === 'connect-tempest') {
    return (
      <div style={{ maxWidth: 480, margin: '0 auto', padding: 'var(--sp-6) var(--sp-5)' }}>
        <TempestConnectForm units={units} onConnected={onConnected} onCancel={() => setMode('choose')} />
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 480, margin: '0 auto', padding: 'var(--sp-6) var(--sp-5)' }}>
      <h2
        style={{
          margin: '0 0 var(--sp-2)',
          fontFamily: 'var(--font-display)',
          fontSize: 22,
          color: 'var(--c-text)',
        }}
      >
        Set up weather
      </h2>
      <p
        style={{
          margin: '0 0 var(--sp-5)',
          fontFamily: 'var(--font-ui)',
          fontSize: 14,
          color: 'var(--c-text-2)',
          lineHeight: 1.6,
        }}
      >
        Connect a personal weather station for hyper-local readings, or use the local weather
        service for your area.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)' }}>
        <div
          style={cardSt}
          role="button"
          tabIndex={0}
          onClick={() => setMode('connect-tempest')}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setMode('connect-tempest');
            }
          }}
        >
          <div
            style={{
              fontFamily: 'var(--font-ui)',
              fontSize: 14,
              fontWeight: 600,
              color: 'var(--c-text)',
              marginBottom: 'var(--sp-2)',
            }}
          >
            Connect a station
          </div>
          {PROVIDERS.map((p) => (
            <div
              key={p.key}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                padding: '6px 0',
                fontFamily: 'var(--font-ui)',
                fontSize: 13,
                color: p.enabled ? 'var(--c-text-2)' : 'var(--c-text-3)',
              }}
            >
              <span>{p.label}</span>
              {!p.enabled && <span style={{ fontSize: 11 }}>Coming soon</span>}
            </div>
          ))}
        </div>

        <div
          style={cardSt}
          role="button"
          tabIndex={0}
          onClick={handleTryLocal}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              handleTryLocal();
            }
          }}
        >
          <div
            style={{
              fontFamily: 'var(--font-ui)',
              fontSize: 14,
              fontWeight: 600,
              color: 'var(--c-text)',
            }}
          >
            {tryingLocal ? 'Checking…' : 'Use local weather'}
          </div>
          <p style={{ margin: '4px 0 0', fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--c-text-2)' }}>
            Use publicly available weather data for your garden's location.
          </p>
        </div>
      </div>

      {triedLocal && error === 'location_not_set' && (
        <p style={{ marginTop: 'var(--sp-4)', fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--c-warning)' }}>
          Set your location first — visit{' '}
          <Link to="/account" style={{ color: 'var(--c-primary)' }}>
            your account settings
          </Link>{' '}
          to add it.
        </p>
      )}
    </div>
  );
}

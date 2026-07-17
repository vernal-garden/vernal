import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { post } from '../../lib/api';
import { formatTemp, formatWindSpeed, formatHumidity, UnitSystem } from '../../lib/units';
import type { WeatherErrorKind } from '../../hooks/useWeather';

interface TestReading {
  temperature: number | null;
  humidity: number | null;
  windSpeed: number | null;
  windDirection: string | null;
  precipitationToday: number | null;
  uvIndex: number | null;
  pressure: number | null;
  readingTimestamp: string;
}

type TestState =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok'; reading: TestReading }
  | { kind: 'fail'; reason: string };

const PROVIDERS = [
  { key: 'pws_tempest', label: 'Tempest WeatherFlow', enabled: true },
  { key: 'ambient', label: 'Ambient Weather', enabled: false },
  { key: 'davis', label: 'Davis Instruments', enabled: false },
  { key: 'other', label: 'Other', enabled: false },
] as const;

const REASON_TEXT: Record<string, string> = {
  auth_failed: 'That access token was rejected. Double-check it and try again.',
  not_found: 'No station found with that ID, or it has no recent observations.',
  unreachable: "Couldn't reach Tempest's servers. Try again in a moment.",
};

const labelSt: React.CSSProperties = {
  display: 'block',
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--c-text-3)',
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  marginBottom: 'var(--sp-1)',
  fontFamily: 'var(--font-ui)',
};

const inputSt: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '8px var(--sp-3)',
  fontSize: 14,
  fontFamily: 'var(--font-ui)',
  border: '1px solid var(--c-border)',
  borderRadius: 'var(--r-md)',
  background: 'var(--c-surface)',
  color: 'var(--c-text)',
  marginBottom: 'var(--sp-3)',
};

const buttonSt: React.CSSProperties = {
  padding: '8px 20px',
  fontSize: 13,
  fontFamily: 'var(--font-ui)',
  border: 'none',
  borderRadius: 'var(--r-md)',
  background: 'var(--c-primary)',
  color: 'var(--c-text-on-primary)',
  cursor: 'pointer',
};

const secondaryButtonSt: React.CSSProperties = {
  padding: '8px 20px',
  fontSize: 13,
  fontFamily: 'var(--font-ui)',
  border: '1px solid var(--c-border)',
  borderRadius: 'var(--r-md)',
  background: 'transparent',
  color: 'var(--c-text-2)',
  cursor: 'pointer',
};

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
  const [accessToken, setAccessToken] = useState('');
  const [stationId, setStationId] = useState('');
  const [testState, setTestState] = useState<TestState>({ kind: 'idle' });
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [triedLocal, setTriedLocal] = useState(false);
  const [tryingLocal, setTryingLocal] = useState(false);

  async function handleTest() {
    if (!accessToken || !stationId) return;
    setTestState({ kind: 'testing' });
    try {
      const res = await post<{ ok: boolean; reading?: TestReading; reason?: string }>(
        '/api/weather/test-connection',
        { provider: 'pws_tempest', credentials: { accessToken }, stationId },
      );
      if (res?.ok && res.reading) {
        setTestState({ kind: 'ok', reading: res.reading });
      } else {
        setTestState({ kind: 'fail', reason: res?.reason ?? 'unreachable' });
      }
    } catch {
      setTestState({ kind: 'fail', reason: 'unreachable' });
    }
  }

  async function handleConnect() {
    setConnecting(true);
    setConnectError(null);
    try {
      await post('/api/weather/connections', {
        provider: 'pws_tempest',
        credentials: { accessToken },
        stationId,
        isPrimary: true,
      });
      onConnected();
    } catch {
      setConnectError('Could not save this connection. Try again.');
    } finally {
      setConnecting(false);
    }
  }

  async function handleTryLocal() {
    setTryingLocal(true);
    setTriedLocal(true);
    await onTryLocalWeather();
    setTryingLocal(false);
  }

  if (mode === 'connect-tempest') {
    return (
      <div style={{ maxWidth: 480, margin: '0 auto', padding: 'var(--sp-6) var(--sp-5)' }}>
        <button onClick={() => setMode('choose')} style={{ ...secondaryButtonSt, marginBottom: 'var(--sp-4)' }}>
          ← Back
        </button>
        <h2
          style={{
            margin: '0 0 var(--sp-4)',
            fontFamily: 'var(--font-display)',
            fontSize: 20,
            color: 'var(--c-text)',
          }}
        >
          Connect your Tempest station
        </h2>

        <label style={labelSt}>Personal access token</label>
        <input
          type="password"
          value={accessToken}
          onChange={(e) => {
            setAccessToken(e.target.value);
            setTestState({ kind: 'idle' });
          }}
          style={inputSt}
          placeholder="Paste your Tempest access token"
        />

        <label style={labelSt}>Station ID</label>
        <input
          type="text"
          value={stationId}
          onChange={(e) => {
            setStationId(e.target.value);
            setTestState({ kind: 'idle' });
          }}
          style={inputSt}
          placeholder="e.g. 12345"
        />

        <div style={{ display: 'flex', gap: 'var(--sp-2)', marginBottom: 'var(--sp-4)' }}>
          <button
            onClick={handleTest}
            disabled={!accessToken || !stationId || testState.kind === 'testing'}
            style={secondaryButtonSt}
          >
            {testState.kind === 'testing' ? 'Testing…' : 'Test connection'}
          </button>
          {testState.kind === 'ok' && (
            <button onClick={handleConnect} disabled={connecting} style={buttonSt}>
              {connecting ? 'Connecting…' : 'Connect'}
            </button>
          )}
        </div>

        {testState.kind === 'ok' && (
          <p
            style={{
              fontSize: 13,
              fontFamily: 'var(--font-ui)',
              color: 'var(--c-success)',
              margin: '0 0 var(--sp-3)',
            }}
          >
            Connected — last reading: {formatTemp(testState.reading.temperature, units) ?? '—'},{' '}
            {formatHumidity(testState.reading.humidity) ?? '—'} humidity,{' '}
            {formatWindSpeed(testState.reading.windSpeed, units) ?? '—'} wind.
          </p>
        )}
        {testState.kind === 'fail' && (
          <p
            style={{
              fontSize: 13,
              fontFamily: 'var(--font-ui)',
              color: 'var(--c-danger)',
              margin: '0 0 var(--sp-3)',
            }}
          >
            {REASON_TEXT[testState.reason] ?? testState.reason}
          </p>
        )}
        {connectError && (
          <p
            style={{
              fontSize: 13,
              fontFamily: 'var(--font-ui)',
              color: 'var(--c-danger)',
              margin: '0 0 var(--sp-3)',
            }}
          >
            {connectError}
          </p>
        )}
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

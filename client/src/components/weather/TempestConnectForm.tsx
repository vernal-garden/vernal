import React, { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { ApiError, post } from '../../lib/api';
import { formatTemp, formatWindSpeed, formatHumidity, UnitSystem } from '../../lib/units';

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

const REASON_TEXT: Record<string, string> = {
  auth_failed: 'That access token was rejected. Double-check it and try again.',
  not_found: 'No station found with that ID, or it has no recent observations.',
  unreachable: "Couldn't reach Tempest's servers. Try again in a moment.",
};

// The server's error text for a 4xx response; null for network failures and
// 5xx, which keep the generic messages.
function clientErrorText(e: unknown): string | null {
  if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
    const body = e.body as { error?: unknown } | null;
    if (body && typeof body.error === 'string') return body.error;
  }
  return null;
}

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
  minHeight: 44,
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
  minHeight: 44,
  minWidth: 44,
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
  minHeight: 44,
  minWidth: 44,
  padding: '8px 20px',
  fontSize: 13,
  fontFamily: 'var(--font-ui)',
  border: '1px solid var(--c-border)',
  borderRadius: 'var(--r-md)',
  background: 'transparent',
  color: 'var(--c-text-2)',
  cursor: 'pointer',
};

const messageSt: React.CSSProperties = {
  fontSize: 13,
  fontFamily: 'var(--font-ui)',
  margin: '0 0 var(--sp-3)',
};

export interface TempestConnectFormHandle {
  focusToken: () => void;
}

interface Props {
  units: UnitSystem;
  onConnected: () => void;
  onCancel?: () => void;
}

// Tempest personal access token + station id form: test, then save the connection.
const TempestConnectForm = forwardRef<TempestConnectFormHandle, Props>(function TempestConnectForm(
  { units, onConnected, onCancel },
  ref,
) {
  const [accessToken, setAccessToken] = useState('');
  const [stationId, setStationId] = useState('');
  const [testState, setTestState] = useState<TestState>({ kind: 'idle' });
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const tokenRef = useRef<HTMLInputElement>(null);

  useImperativeHandle(ref, () => ({ focusToken: () => tokenRef.current?.focus() }), []);

  async function handleTest() {
    if (!accessToken.trim() || !stationId.trim()) return;
    setTestState({ kind: 'testing' });
    try {
      const res = await post<{ ok: boolean; reading?: TestReading; reason?: string }>(
        '/api/weather/test-connection',
        { provider: 'pws_tempest', credentials: { accessToken: accessToken.trim() }, stationId: stationId.trim() },
      );
      if (res?.ok && res.reading) {
        setTestState({ kind: 'ok', reading: res.reading });
      } else {
        setTestState({ kind: 'fail', reason: res?.reason ?? 'unreachable' });
      }
    } catch (e) {
      // A 4xx carries the server's reason (e.g. a malformed station id); show it.
      setTestState({ kind: 'fail', reason: clientErrorText(e) ?? 'unreachable' });
    }
  }

  async function handleConnect() {
    setConnecting(true);
    setConnectError(null);
    try {
      await post('/api/weather/connections', {
        provider: 'pws_tempest',
        credentials: { accessToken: accessToken.trim() },
        stationId: stationId.trim(),
        isPrimary: true,
      });
      onConnected();
    } catch (e) {
      setConnectError(clientErrorText(e) ?? 'Could not save this connection. Try again.');
    } finally {
      setConnecting(false);
    }
  }

  return (
    <div>
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

      <label htmlFor="tempest-access-token" style={labelSt}>Personal access token</label>
      <input
        id="tempest-access-token"
        ref={tokenRef}
        type="password"
        value={accessToken}
        onChange={(e) => {
          setAccessToken(e.target.value);
          setTestState({ kind: 'idle' });
        }}
        style={inputSt}
        placeholder="Paste your Tempest access token"
      />

      <label htmlFor="tempest-station-id" style={labelSt}>Station ID</label>
      <input
        id="tempest-station-id"
        type="text"
        value={stationId}
        onChange={(e) => {
          setStationId(e.target.value);
          setTestState({ kind: 'idle' });
        }}
        style={inputSt}
        placeholder="e.g. 12345"
      />

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--sp-2)', marginBottom: 'var(--sp-4)' }}>
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
        {onCancel && (
          <button onClick={onCancel} style={secondaryButtonSt}>
            {/* ED: replace with final copy */}
            Cancel
          </button>
        )}
      </div>

      {testState.kind === 'ok' && (
        <p style={{ ...messageSt, color: 'var(--c-success)' }}>
          Connected — last reading: {formatTemp(testState.reading.temperature, units) ?? '—'},{' '}
          {formatHumidity(testState.reading.humidity) ?? '—'} humidity,{' '}
          {formatWindSpeed(testState.reading.windSpeed, units) ?? '—'} wind.
        </p>
      )}
      {testState.kind === 'fail' && (
        <p style={{ ...messageSt, color: 'var(--c-danger)' }}>
          {REASON_TEXT[testState.reason] ?? testState.reason}
        </p>
      )}
      {connectError && <p style={{ ...messageSt, color: 'var(--c-danger)' }}>{connectError}</p>}
    </div>
  );
});

export default TempestConnectForm;

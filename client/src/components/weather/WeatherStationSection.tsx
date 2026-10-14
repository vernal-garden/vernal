import React, { useEffect, useRef } from 'react';
import type { UnitSystem } from '../../lib/units';
import TempestConnectForm, { type TempestConnectFormHandle } from './TempestConnectForm';
import { PROVIDERS } from './providers';

const textSt: React.CSSProperties = {
  margin: '0 0 var(--sp-3)',
  fontFamily: 'var(--font-ui)',
  fontSize: 14,
  color: 'var(--c-text-2)',
  lineHeight: 1.6,
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

interface Props {
  units: UnitSystem;
  locationLabel: string | null;
  expanded: boolean;
  // Arrived via ?connect=station: bring the form into view and focus the token field.
  focusOnOpen: boolean;
  onExpand: () => void;
  onCollapse: () => void;
  onConnected: () => void;
}

// Shown on the Weather page when a location is set but no personal station is connected.
export default function WeatherStationSection({
  units,
  locationLabel,
  expanded,
  focusOnOpen,
  onExpand,
  onCollapse,
  onConnected,
}: Props) {
  const sectionRef = useRef<HTMLElement>(null);
  const formRef = useRef<TempestConnectFormHandle>(null);

  useEffect(() => {
    if (!expanded || !focusOnOpen) return;
    sectionRef.current?.scrollIntoView({ block: 'start' });
    formRef.current?.focusToken();
  }, [expanded, focusOnOpen]);

  return (
    <section
      ref={sectionRef}
      aria-labelledby="weather-station-title"
      style={{ marginTop: 'var(--sp-6)', borderTop: '1px solid var(--c-border-subtle)', paddingTop: 'var(--sp-4)' }}
    >
      <h3
        id="weather-station-title"
        style={{
          margin: '0 0 var(--sp-3)',
          fontFamily: 'var(--font-display)',
          fontSize: 15,
          color: 'var(--c-text)',
        }}
      >
        {/* ED: replace with final copy */}
        Your weather station
      </h3>

      {!expanded && (
        <>
          <p style={textSt}>
            {/* ED: replace with final copy */}
            Using the local weather service{locationLabel ? ` for ${locationLabel}` : ''}. Connect a personal
            station for readings from your yard.
          </p>
          <button onClick={onExpand} style={buttonSt}>
            {/* ED: replace with final copy */}
            Connect a station
          </button>
        </>
      )}

      {expanded && (
        <>
          <TempestConnectForm ref={formRef} units={units} onConnected={onConnected} onCancel={onCollapse} />
          <div
            style={{
              border: '1px solid var(--c-border)',
              borderRadius: 'var(--r-lg)',
              padding: 'var(--sp-3) var(--sp-5)',
              background: 'var(--c-surface)',
            }}
          >
            {PROVIDERS.filter((p) => !p.enabled).map((p) => (
              <div
                key={p.key}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  padding: '6px 0',
                  fontFamily: 'var(--font-ui)',
                  fontSize: 13,
                  color: 'var(--c-text-3)',
                }}
              >
                <span>{p.label}</span>
                <span style={{ fontSize: 11 }}>Coming soon</span>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

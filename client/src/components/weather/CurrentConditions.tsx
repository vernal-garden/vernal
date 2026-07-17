import React from 'react';
import type { CurrentReading } from '../../hooks/useWeather';
import {
  UnitSystem,
  formatTemp,
  formatWindSpeed,
  formatPrecip,
  formatPressure,
  formatHumidity,
  formatUvIndex,
} from '../../lib/units';

const SOURCE_LABEL: Record<string, string> = {
  pws_tempest: 'Tempest WeatherFlow',
  public_weather: 'Local weather service',
};

function relativeTime(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min${mins === 1 ? '' : 's'} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

interface CardDef {
  label: string;
  value: string | null;
}

const cardSt: React.CSSProperties = {
  padding: 'var(--sp-4)',
  borderRadius: 'var(--r-lg)',
  background: 'var(--c-surface-raised)',
  textAlign: 'center',
};

const labelSt: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--c-text-3)',
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  fontFamily: 'var(--font-ui)',
  marginBottom: 4,
};

const valueSt: React.CSSProperties = {
  fontSize: 22,
  fontWeight: 700,
  color: 'var(--c-text)',
  fontFamily: 'var(--font-display)',
};

interface Props {
  reading: CurrentReading;
  units: UnitSystem;
  onRefresh: () => void;
  refreshing: boolean;
}

export default function CurrentConditions({ reading, units, onRefresh, refreshing }: Props) {
  const cards: CardDef[] = [
    { label: 'Temperature', value: formatTemp(reading.temperature, units) },
    { label: 'Humidity', value: formatHumidity(reading.humidity) },
    {
      label: 'Wind',
      value:
        reading.windSpeed !== null
          ? `${formatWindSpeed(reading.windSpeed, units)}${reading.windDirection ? ` ${reading.windDirection}` : ''}`
          : null,
    },
    { label: 'Precip. Today', value: formatPrecip(reading.precipitationToday, units) },
    { label: 'UV Index', value: formatUvIndex(reading.uvIndex) },
    { label: 'Pressure', value: formatPressure(reading.pressure, units) },
  ].filter((c) => c.value !== null);

  return (
    <div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
          gap: 'var(--sp-3)',
          marginBottom: 'var(--sp-3)',
        }}
      >
        {cards.map((c) => (
          <div key={c.label} style={cardSt}>
            <div style={labelSt}>{c.label}</div>
            <div style={valueSt}>{c.value}</div>
          </div>
        ))}
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--sp-2)',
          fontFamily: 'var(--font-ui)',
          fontSize: 12,
          color: 'var(--c-text-3)',
        }}
      >
        <span>{SOURCE_LABEL[reading.source] ?? reading.source}</span>
        <span>·</span>
        <span>
          Updated {relativeTime(reading.readingTimestamp)}
          {reading.cached ? ' (cached)' : ''}
        </span>
        <button
          onClick={onRefresh}
          disabled={refreshing}
          aria-label="Refresh weather"
          style={{
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            color: 'var(--c-primary)',
            fontSize: 13,
            padding: 0,
            marginLeft: 4,
          }}
        >
          {refreshing ? '…' : '⟳'}
        </button>
      </div>
    </div>
  );
}

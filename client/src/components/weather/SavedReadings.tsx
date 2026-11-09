// client/src/components/weather/SavedReadings.tsx
import React, { useEffect, useRef, useState } from 'react';
import { get } from '../../lib/api';
import { UnitSystem, formatTemp, formatHumidity, formatWindSpeed, formatPrecip } from '../../lib/units';

const STRINGS = {
  toggle: 'Saved readings',
  more: 'Load more',
  empty: 'No readings saved yet.',
  loading: 'Loading…',
  error: 'Weather data unavailable — try again.',
  retry: 'Retry',
};

interface Reading {
  id: string;
  readingTimestamp: string;
  temperature: number | null;
  humidity: number | null;
  windSpeed: number | null;
  windDirection: string | null;
  precipitationToday: number | null;
  uvIndex: number | null;
  pressure: number | null;
}

interface ReadingsPage {
  data: Reading[];
  nextCursor: string | null;
}

const textBtnSt: React.CSSProperties = {
  border: 'none',
  background: 'transparent',
  padding: 0,
  minHeight: 44,
  fontFamily: 'var(--font-ui)',
  fontSize: 13,
  color: 'var(--c-primary)',
  cursor: 'pointer',
};

const rowSt: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  columnGap: 'var(--sp-3)',
  rowGap: 2,
  padding: 'var(--sp-2) 0',
  borderTop: '1px solid var(--c-border-subtle)',
  color: 'var(--c-text-2)',
};

const timeSt: React.CSSProperties = { color: 'var(--c-text)' };

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatValues(r: Reading, units: UnitSystem): string {
  const wind =
    r.windSpeed !== null
      ? `${formatWindSpeed(r.windSpeed, units)}${r.windDirection ? ` ${r.windDirection}` : ''}`
      : null;
  return [formatTemp(r.temperature, units), formatHumidity(r.humidity), wind, formatPrecip(r.precipitationToday, units)]
    .filter((v) => v !== null)
    .join(' · ');
}

interface Props {
  connectionId: string;
  units: UnitSystem;
}

export default function SavedReadings({ connectionId, units }: Props) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Reading[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function fetchPage(cursor: string | null) {
    setLoading(true);
    setFailed(false);
    try {
      const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
      const res = await get<ReadingsPage>(`/api/weather/connections/${connectionId}/readings${qs}`);
      if (!mounted.current) return;
      setRows((prev) => (cursor ? [...prev, ...(res?.data ?? [])] : (res?.data ?? [])));
      setNextCursor(res?.nextCursor ?? null);
      setLoaded(true);
    } catch {
      if (mounted.current) setFailed(true);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && !loaded && !loading) void fetchPage(null);
  }

  return (
    <div style={{ fontFamily: 'var(--font-ui)', fontSize: 13 }}>
      <button type="button" onClick={toggle} aria-expanded={open} style={textBtnSt}>
        {STRINGS.toggle}
      </button>

      {open && (
        <div>
          {!loaded && loading && <div style={{ color: 'var(--c-text-2)' }}>{STRINGS.loading}</div>}

          {!loaded && failed && (
            <div style={{ color: 'var(--c-text-2)' }}>
              <p style={{ margin: 0 }}>{STRINGS.error}</p>
              <button type="button" onClick={() => void fetchPage(null)} disabled={loading} style={textBtnSt}>
                {STRINGS.retry}
              </button>
            </div>
          )}

          {loaded && rows.length === 0 && <div style={{ color: 'var(--c-text-2)' }}>{STRINGS.empty}</div>}

          {rows.map((r) => (
            <div key={r.id} style={rowSt}>
              <span style={timeSt}>{formatTime(r.readingTimestamp)}</span>
              <span>{formatValues(r, units)}</span>
            </div>
          ))}

          {loaded && failed && <div style={{ color: 'var(--c-text-2)' }}>{STRINGS.error}</div>}

          {loaded && nextCursor && (
            <button type="button" onClick={() => void fetchPage(nextCursor)} disabled={loading} style={textBtnSt}>
              {STRINGS.more}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

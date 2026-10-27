import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useIsMobile } from '../hooks/useIsMobile';
import { useComparablePlants, useCrossSeason } from '../hooks/useMetrics';
import { parseSeedParam } from '../hooks/useHarvests';
import { track } from '../lib/track';
import { useMicroFeedback } from '../lib/microFeedback';
import UpgradePrompt from '../components/UpgradePrompt';
import { spinnerStyle } from '../components/harvest/formStyles';
import { textButtonStyle } from '../components/guide/styles';
import ComparePlantPicker from '../components/metrics/ComparePlantPicker';
import CompareSeasonsView, { SEASON_COLORS } from '../components/metrics/CompareSeasonsView';
import {
  bodyTextStyle,
  cardStyle,
  dotStyle,
  linkStyle,
  plantKeyOf,
  plantName,
  subheadingStyle,
} from '../components/metrics/styles';

// /data/compare — the Cross-Season Comparison (spec 6.6). Supporters only.
// The server picks the default seasons and does every total; this page
// renders what it returns.

const MAX_SEASONS = 4;
const FEEDBACK_DELAY_MS = 5000;

export default function ComparePage() {
  const { account } = useAuth();
  const isSupporter = account?.subscriptionTier === 'supporter';
  const isMobile = useIsMobile();
  const [searchParams, setSearchParams] = useSearchParams();
  const plantKey = parseSeedParam(searchParams.get('plant'));

  const [gardenId, setGardenId] = useState<string | null>(null);
  const [bedId, setBedId] = useState<string | null>(null);
  // null: the server's default (the two most recent seasons with data).
  const [seasons, setSeasons] = useState<number[] | null>(null);
  const [limitMessage, setLimitMessage] = useState('');
  // Mobile: the controls collapse once a plant is chosen.
  const [controlsOpen, setControlsOpen] = useState(plantKey === null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  // A different plant (picked here or from the URL) starts from the server's
  // defaults. Reset during render so no request goes out with the old
  // plant's filters.
  const [prevPlant, setPrevPlant] = useState(plantKey);
  if (prevPlant !== plantKey) {
    setPrevPlant(plantKey);
    setGardenId(null);
    setBedId(null);
    setSeasons(null);
    setLimitMessage('');
  }

  const { plants, loading: plantsLoading, error: plantsError, reload: reloadPlants } = useComparablePlants(isSupporter);
  const { data, loading, error, errorStatus, reload } = useCrossSeason(
    isSupporter && plantKey ? { plant: plantKey, gardenId, bedId, seasons } : null,
  );

  function choosePlant(key: string) {
    const next = new URLSearchParams(searchParams);
    next.set('plant', key);
    setSearchParams(next, { replace: true });
    setControlsOpen(false);
    // Mobile: the combobox is about to be hidden; keep focus on the panel toggle.
    if (isMobile) window.requestAnimationFrame(() => toggleRef.current?.focus());
  }

  // Tracked once per visit, the first time a comparison is on screen.
  const tracked = useRef(false);
  useEffect(() => {
    if (data === null || tracked.current) return;
    tracked.current = true;
    track('crossseason_comparison_viewed');
  }, [data]);

  // After a comparison has been on screen for 5 seconds, ask for feedback.
  // A plant change or leaving the page cancels the wait.
  const request = useMicroFeedback();
  const hasComparison = data !== null;
  useEffect(() => {
    if (!hasComparison) return;
    const timer = window.setTimeout(() => request('cross_season'), FEEDBACK_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [hasComparison, plantKey, request]);

  if (!isSupporter || errorStatus === 402) {
    return (
      <div style={{ padding: 'var(--sp-6)' }}>
        <UpgradePrompt gateKey="crossSeason" />
      </div>
    );
  }

  const pageStyle: CSSProperties = {
    maxWidth: 1120,
    width: '100%',
    boxSizing: 'border-box',
    margin: '0 auto',
    padding: isMobile ? 'var(--sp-4)' : 'var(--sp-6) var(--sp-5)',
    fontFamily: 'var(--font-ui)',
    background: 'var(--c-bg)',
  };

  const header = !isMobile && (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-1)', marginBottom: 'var(--sp-4)' }}>
      {/* ED: replace with final copy */}
      <Link to="/data" style={{ ...linkStyle, alignSelf: 'flex-start', fontWeight: 500 }}>Back to Data</Link>
      <h1 style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 30, fontWeight: 600, color: 'var(--c-text)' }}>
        Compare seasons
      </h1>
    </div>
  );

  const spinner = (
    // ED: replace with final copy
    <div role="status" aria-label="Loading" style={{ display: 'flex', justifyContent: 'center', padding: 'var(--sp-9) 0' }}>
      <div style={spinnerStyle} />
    </div>
  );

  if (plantsLoading) {
    return (
      <div style={pageStyle}>
        {header}
        {spinner}
      </div>
    );
  }

  if (plantsError) {
    return (
      <div style={pageStyle}>
        {header}
        <div role="alert" style={{ textAlign: 'center', color: 'var(--c-danger)', padding: 'var(--sp-7) 0' }}>
          <p style={{ margin: '0 0 var(--sp-3)' }}>{plantsError}</p>
          {/* ED: replace with final copy */}
          <button type="button" onClick={() => void reloadPlants()} style={textButtonStyle}>Retry</button>
        </div>
      </div>
    );
  }

  if (plants.length === 0) {
    return (
      <div style={pageStyle}>
        {header}
        <div style={{ ...cardStyle, alignItems: 'center', textAlign: 'center', padding: 'var(--sp-7) var(--sp-5)' }}>
          <p style={{ ...bodyTextStyle, maxWidth: 480 }}>
            You&rsquo;ll be able to compare seasons once you have two seasons of data for the same plant. Keep logging and check back next season.
          </p>
          {/* ED: replace with final copy */}
          <Link to="/data" style={linkStyle}>Back to Data</Link>
        </div>
      </div>
    );
  }

  // Seasons shown as checked: the explicit choice, else what the server picked.
  const checked = seasons ?? data?.seasons.map((s) => s.season) ?? [];

  function toggleSeason(season: number, on: boolean) {
    if (on) {
      if (checked.includes(season)) return;
      if (checked.length >= MAX_SEASONS) {
        setLimitMessage('Compare up to 4 seasons.');
        return;
      }
      setLimitMessage('');
      setSeasons([...checked, season].sort((a, b) => a - b));
    } else {
      if (checked.length <= 1) {
        // ED: replace with final copy
        setLimitMessage('Keep at least one season selected.');
        return;
      }
      setLimitMessage('');
      setSeasons(checked.filter((s) => s !== season));
    }
  }

  const gardens = data?.gardens ?? [];
  const bedOptions = (data?.beds ?? []).filter((b) => gardenId === null || b.gardenId === gardenId);
  const showGardenFilter = gardens.length > 1;
  const showBedFilter = bedOptions.length > 1;
  const gardenNameOf = (id: string) => gardens.find((g) => g.id === id)?.name ?? '';

  const controls = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)' }}>
      <ComparePlantPicker
        plants={plants}
        value={plantKey}
        fallbackName={data ? plantName(data.plant.commonName) : null}
        onChange={choosePlant}
      />

      {data && (showGardenFilter || showBedFilter) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)' }}>
          {showGardenFilter && (
            <label style={filterLabelStyle}>
              {/* ED: replace with final copy */}
              Garden
              <select
                value={gardenId ?? ''}
                onChange={(e) => {
                  const next = e.target.value === '' ? null : e.target.value;
                  setGardenId(next);
                  // A bed from another garden no longer applies.
                  if (next !== null && bedId !== null && !data.beds.some((b) => b.id === bedId && b.gardenId === next)) {
                    setBedId(null);
                  }
                }}
                style={selectStyle}
              >
                <option value="">All gardens</option>
                {gardens.map((g) => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </select>
            </label>
          )}
          {showBedFilter && (
            <label style={filterLabelStyle}>
              {/* ED: replace with final copy */}
              Bed
              <select
                value={bedId ?? ''}
                onChange={(e) => setBedId(e.target.value === '' ? null : e.target.value)}
                style={selectStyle}
              >
                {/* ED: replace with final copy */}
                <option value="">All beds</option>
                {bedOptions.map((b) => (
                  <option key={b.id} value={b.id}>
                    {(b.label || 'Unnamed bed') + (gardenId === null && showGardenFilter ? ` (${gardenNameOf(b.gardenId)})` : '')}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}

      {data && (
        <fieldset style={{ margin: 0, padding: 0, border: 'none', minWidth: 0 }}>
          {/* ED: replace with final copy */}
          <legend style={{ ...subheadingStyle, marginBottom: 'var(--sp-2)' }}>Seasons</legend>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {data.availableSeasons.map((year) => {
              const isChecked = checked.includes(year);
              const shownIndex = data.seasons.findIndex((s) => s.season === year);
              return (
                <label key={year} style={checkboxRowStyle}>
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={(e) => toggleSeason(year, e.target.checked)}
                    style={{ width: 20, height: 20, margin: 0, accentColor: 'var(--c-primary)', cursor: 'pointer' }}
                  />
                  <span>{year}</span>
                  {shownIndex >= 0 && (
                    <span aria-hidden="true" style={dotStyle(SEASON_COLORS[shownIndex % SEASON_COLORS.length])} />
                  )}
                </label>
              );
            })}
          </div>
          <p aria-live="polite" style={{ margin: 'var(--sp-1) 0 0', minHeight: 20, fontSize: 13, color: 'var(--c-text-2)' }}>
            {limitMessage}
          </p>
        </fieldset>
      )}
    </div>
  );

  let content;
  if (plantKey === null) {
    // ED: replace with final copy
    content = <p style={bodyTextStyle}>Choose a plant to see its seasons side by side.</p>;
  } else if (data) {
    content = (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)', minWidth: 0 }}>
        <div>
          <h2 style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 600, color: 'var(--c-text)' }}>
            {plantName(data.plant.commonName)}
          </h2>
          {data.plant.scientificName && (
            <p style={{ margin: 0, fontSize: 13, fontStyle: 'italic', color: 'var(--c-text-3)' }}>{data.plant.scientificName}</p>
          )}
        </div>
        {error && !loading && (
          <p role="alert" style={{ margin: 0, padding: 'var(--sp-3) var(--sp-4)', background: 'var(--c-danger-bg)', color: 'var(--c-text)', borderRadius: 'var(--r-md)', fontSize: 14 }}>
            {error}{' '}
            {/* ED: replace with final copy */}
            <button type="button" onClick={() => void reload()} style={textButtonStyle}>Retry</button>
          </p>
        )}
        {/* Remount per plant so the open season and view state start fresh. */}
        <CompareSeasonsView key={plantKey} data={data} isMobile={isMobile} refreshing={loading || !!error} />
      </div>
    );
  } else if (loading) {
    content = spinner;
  } else if (error) {
    content = (
      <div role="alert" style={{ textAlign: 'center', color: errorStatus === 404 ? 'var(--c-text-2)' : 'var(--c-danger)', padding: 'var(--sp-7) 0' }}>
        <p style={{ margin: '0 0 var(--sp-3)' }}>{error}</p>
        {errorStatus !== 404 && (
          // ED: replace with final copy
          <button type="button" onClick={() => void reload()} style={textButtonStyle}>Retry</button>
        )}
      </div>
    );
  } else {
    content = null;
  }

  const chosenPlant = plantKey === null ? undefined : plants.find((p) => plantKeyOf(p) === plantKey);
  const chosenName = data
    ? plantName(data.plant.commonName)
    : chosenPlant
      ? plantName(chosenPlant.commonName)
      : null;

  return (
    <div style={pageStyle}>
      {header}
      {isMobile ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)' }}>
          <div style={{ ...cardStyle, padding: 'var(--sp-3)' }}>
            <button
              ref={toggleRef}
              type="button"
              aria-expanded={controlsOpen}
              aria-controls="compare-controls"
              onClick={() => setControlsOpen((o) => !o)}
              style={{ ...textButtonStyle, justifyContent: 'space-between', width: '100%', border: 'none', padding: '0 var(--sp-2)' }}
            >
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {controlsOpen ? 'Hide options' : chosenName ? `${chosenName} · Change options` : 'Choose a plant'}
              </span>
              <span aria-hidden="true">{controlsOpen ? '▴' : '▾'}</span>
            </button>
            <div id="compare-controls" hidden={!controlsOpen} style={{ paddingTop: controlsOpen ? 'var(--sp-3)' : 0 }}>
              {controls}
            </div>
          </div>
          {content}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '300px minmax(0, 1fr)', gap: 'var(--sp-5)', alignItems: 'start' }}>
          {/* ED: replace with final copy */}
          <aside aria-label="Comparison options" style={cardStyle}>{controls}</aside>
          <div style={{ minWidth: 0 }}>{content}</div>
        </div>
      )}
    </div>
  );
}

const filterLabelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--sp-1)',
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--c-text-2)',
};

const selectStyle: CSSProperties = {
  minHeight: 44,
  width: '100%',
  padding: '0 var(--sp-3)',
  fontFamily: 'var(--font-ui)',
  fontSize: 14,
  fontWeight: 400,
  color: 'var(--c-text)',
  background: 'var(--c-surface)',
  border: '1px solid var(--c-border)',
  borderRadius: 'var(--r-md)',
  cursor: 'pointer',
};

const checkboxRowStyle: CSSProperties = {
  minHeight: 44,
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--sp-3)',
  fontSize: 14,
  color: 'var(--c-text)',
  cursor: 'pointer',
};

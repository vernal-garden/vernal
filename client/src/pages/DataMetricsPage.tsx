import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useIsMobile } from '../hooks/useIsMobile';
import { useDashboard } from '../hooks/useMetrics';
import { track } from '../lib/track';
import SeasonSelector from '../components/guide/SeasonSelector';
import { tagStyle, textButtonStyle } from '../components/guide/styles';
import { spinnerStyle } from '../components/harvest/formStyles';
import UpgradeCard from '../components/UpgradeCard';
import MetricsEmptyState from '../components/metrics/MetricsEmptyState';
import SummaryStrip from '../components/metrics/SummaryStrip';
import HarvestTotalsCard from '../components/metrics/HarvestTotalsCard';
import RecentActivityCard from '../components/metrics/RecentActivityCard';
import PlantingTimingCard from '../components/metrics/PlantingTimingCard';
import TrendCard from '../components/metrics/TrendCard';
import SoilSummaryCard from '../components/metrics/SoilSummaryCard';
import AmendmentSummaryCard from '../components/metrics/AmendmentSummaryCard';
import WeatherCard from '../components/metrics/WeatherCard';
import AdvancedPanel from '../components/metrics/AdvancedPanel';

// /data — the Metrics Dashboard (spec 6.1). Read-only: a season journal of
// what the server has already totalled.
export default function DataMetricsPage() {
  const isMobile = useIsMobile();
  // null until the user picks a season: the first load asks the server for
  // its current season.
  const [season, setSeason] = useState<number | null>(null);
  const [gardenId, setGardenId] = useState<string | null>(null);
  // Set when a garden toggle failed and the select was put back.
  const [gardenError, setGardenError] = useState<{ message: string; gardenId: string | null } | null>(null);
  const { data, loadedGardenId, loading, error, errorStatus, reload } = useDashboard(season, gardenId);

  const tracked = useRef(false);
  useEffect(() => {
    if (tracked.current) return;
    tracked.current = true;
    track('metrics_dashboard_viewed');
  }, []);

  // The season whose numbers are (or should be) on screen.
  const requestedSeason = season ?? data?.season ?? null;
  const seasonMismatch = data !== null && requestedSeason !== null && data.season !== requestedSeason;

  // A garden toggle failed. A 404 means the garden is gone: fall back to all
  // gardens. Otherwise put the select back on the garden whose totals are
  // still shown, so the two never disagree, and say what failed.
  useEffect(() => {
    if (!error || loading || !data || seasonMismatch || gardenId === loadedGardenId) return;
    if (errorStatus !== 404) {
      const name = data.gardens.find((g) => g.id === gardenId)?.name;
      setGardenError({
        // ED: replace with final copy
        message: name ? `Couldn't load totals for ${name}.` : "Couldn't load those totals.",
        gardenId,
      });
    }
    setGardenId(errorStatus === 404 ? null : loadedGardenId);
  }, [error, errorStatus, loading, data, seasonMismatch, gardenId, loadedGardenId]);

  function changeSeason(next: number) {
    setSeason(next);
    setGardenError(null);
  }

  function changeGarden(next: string | null) {
    setGardenId(next);
    setGardenError(null);
  }

  const pagePadding = isMobile ? 'var(--sp-4)' : 'var(--sp-6) var(--sp-5)';
  const pageStyle: CSSProperties = {
    maxWidth: 1120,
    width: '100%',
    boxSizing: 'border-box',
    margin: '0 auto',
    padding: pagePadding,
    fontFamily: 'var(--font-ui)',
    background: 'var(--c-bg)',
  };

  // What the body shows. A season change replaces the body; a garden toggle
  // keeps it on screen (the totals card dims while it loads).
  const showSpinner = loading && (data === null || seasonMismatch);
  const seasonFailed = !loading && error !== null && (data === null || seasonMismatch);
  const showData = data !== null && !seasonMismatch;
  const isPastSeason = data !== null && data.season < data.currentSeason;

  let errorText: string | null = null;
  if (seasonFailed) {
    // ED: replace with final copy
    errorText = requestedSeason !== null
      ? `Couldn't load your ${requestedSeason} season's data.`
      : "Couldn't load your season's data.";
  } else if (gardenError) {
    errorText = gardenError.message;
  } else if (error && !loading && showData && gardenId === loadedGardenId) {
    errorText = error;
  }

  const twoCol: CSSProperties = {
    display: 'grid',
    gridTemplateColumns: isMobile ? 'minmax(0, 1fr)' : 'repeat(2, minmax(0, 1fr))',
    gap: 'var(--sp-4)',
    alignItems: 'stretch',
  };
  const fullWidth: CSSProperties = isMobile ? {} : { gridColumn: '1 / -1' };

  return (
    <div style={pageStyle}>
      {/* One header for every state, so focus on the season selector survives
          a season change. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)', marginBottom: 'var(--sp-4)' }}>
        {!isMobile && (
          <h1 style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 30, fontWeight: 600, color: 'var(--c-text)' }}>
            Data
          </h1>
        )}
        {data && requestedSeason !== null && (
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--sp-3)' }}>
            <SeasonSelector currentSeason={data.currentSeason} season={requestedSeason} onChange={changeSeason} includeNext={false} />
            {requestedSeason < data.currentSeason && <span style={tagStyle}>Past season</span>}
          </div>
        )}
        {showData && !data.empty && <SummaryStrip summary={data.summary} isPastSeason={isPastSeason} season={data.season} />}
        {errorText && (
          <p
            role="alert"
            style={{
              margin: 0,
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: 'var(--sp-2)',
              padding: 'var(--sp-2) var(--sp-4)',
              background: 'var(--c-danger-bg)',
              color: 'var(--c-text)',
              borderRadius: 'var(--r-md)',
              fontSize: 14,
            }}
          >
            {errorText}
            <button
              type="button"
              onClick={() => (gardenError ? changeGarden(gardenError.gardenId) : void reload())}
              style={textButtonStyle}
            >
              {/* ED: replace with final copy */}
              Retry
            </button>
          </p>
        )}
      </div>

      {showSpinner && (
        // ED: replace with final copy
        <div role="status" aria-label="Loading" style={{ display: 'flex', justifyContent: 'center', padding: 'var(--sp-9) 0' }}>
          <div style={spinnerStyle} />
        </div>
      )}

      {showData && !showSpinner && (data.empty ? (
        <MetricsEmptyState isPastSeason={isPastSeason} season={data.season} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)' }}>
          <div style={twoCol}>
            <HarvestTotalsCard
              totals={data.totals}
              season={data.season}
              gardens={data.gardens}
              gardenId={gardenId}
              onGardenChange={changeGarden}
              refreshing={loading}
              isPastSeason={isPastSeason}
            />
            <RecentActivityCard recent={data.recent} />
          </div>

          <div style={twoCol}>
            {/* A grid wrapper so the card still fills the row height. */}
            <div style={{ display: 'grid', minWidth: 0, ...(data.trend.state === 'hidden' ? fullWidth : {}) }}>
              <PlantingTimingCard timing={data.timing} gardens={data.gardens} />
            </div>
            <TrendCard trend={data.trend} />
          </div>

          <div style={twoCol}>
            {data.isSupporter && data.paid ? (
              <>
                <SoilSummaryCard soil={data.paid.soil} gardens={data.gardens} isPastSeason={isPastSeason} season={data.season} />
                <AmendmentSummaryCard amendments={data.paid.amendments} gardens={data.gardens} isPastSeason={isPastSeason} season={data.season} />
                <WeatherCard weather={data.paid.weather} isCurrentSeason={data.season === data.currentSeason} />
                <div style={fullWidth}>
                  <AdvancedPanel advanced={data.paid.advanced} isMobile={isMobile} />
                </div>
              </>
            ) : (
              <>
                <UpgradeCard gateKey="soilSummary" />
                <UpgradeCard gateKey="amendmentSummary" />
                <UpgradeCard gateKey="weatherSummary" />
                <UpgradeCard gateKey="advancedAnalytics" style={fullWidth} />
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

import { Link } from 'react-router-dom';
import type { PaidMetrics } from '../../types/metrics';
import type { WeatherInsight } from '../../types/weather';
import { formatInsight } from '../../lib/weatherInsights';
import { formatPrecip, formatTemp, precipRoundsToZero } from '../../lib/units';
import { bodyTextStyle, cardStyle, cardTitleStyle, linkStyle, listStyle, secondaryTextStyle } from './styles';

const PROVIDER_LABEL: Record<string, string> = {
  pws_tempest: 'Tempest WeatherFlow',
};

const SYNC_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

// The week line already gives the range, so temp_swing and steady are skipped.
const CARD_INSIGHT_KINDS: ReadonlySet<WeatherInsight['kind']> = new Set([
  'dry_spell',
  'frost_risk',
  'warming',
  'cooling',
]);
const MAX_INSIGHTS = 2;

function formatSync(iso: string): string | null {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : SYNC_FORMAT.format(d);
}

function sourceLine(weather: PaidMetrics['weather']): string | null {
  const { station, locationLabel } = weather;
  if (station) {
    const provider = PROVIDER_LABEL[station.provider] ?? station.provider;
    const synced = station.lastSuccessfulSync ? formatSync(station.lastSuccessfulSync) : null;
    // ED: replace with final copy
    return `Your ${provider} station · ${synced ? `last synced ${synced}` : 'not synced yet'}`;
  }
  // ED: replace with final copy
  if (locationLabel !== null) return `Local weather service · ${locationLabel}`;
  return null;
}

function weekLine(weather: PaidMetrics['weather']): string | null {
  const { week, units } = weather;
  if (!week) return null;
  const rain =
    precipRoundsToZero(week.precipMm, units)
      ?// ED: replace with final copy
        'no rain'
      : // ED: replace with final copy
        `${formatPrecip(week.precipMm, units)} of rain`;
  // ED: replace with final copy
  return `${formatTemp(week.minLowC, units)} to ${formatTemp(week.maxHighC, units)} this week · ${rain}`;
}

// Recent local weather, from the account's station or the location's forecast service.
export default function WeatherCard({
  weather,
  isCurrentSeason,
}: {
  weather: PaidMetrics['weather'];
  isCurrentSeason: boolean;
}) {
  const source = sourceLine(weather);
  const week = weekLine(weather);
  const insights = weather.insights
    .filter((i) => CARD_INSIGHT_KINDS.has(i.kind))
    .slice(0, MAX_INSIGHTS)
    .map((i) => formatInsight(i, weather.units));
  const noLocation = weather.locationLabel === null && weather.station === null;

  return (
    <section aria-labelledby="metrics-weather-title" style={cardStyle}>
      {/* ED: replace with final copy */}
      <h2 id="metrics-weather-title" style={cardTitleStyle}>Weather</h2>
      {source && <p style={{ ...secondaryTextStyle, margin: 0 }}>{source}</p>}
      {week && <p style={bodyTextStyle}>{week}</p>}
      {insights.length > 0 && (
        <ul style={{ ...listStyle, gap: 'var(--sp-2)' }}>
          {insights.map((text) => (
            <li key={text} style={bodyTextStyle}>{text}</li>
          ))}
        </ul>
      )}
      {!isCurrentSeason && weather.locationLabel !== null && (
        // ED: replace with final copy
        <p style={bodyTextStyle}>Recent weather is shown for the current season only.</p>
      )}
      {weather.historyUnavailable && (
        // ED: replace with final copy
        <p style={bodyTextStyle}>Weather history isn't available right now.</p>
      )}
      {noLocation && (
        <Link to="/weather" style={{ ...linkStyle, alignSelf: 'flex-start' }}>
          {/* ED: replace with final copy */}
          Set your location to see local weather.
        </Link>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', columnGap: 'var(--sp-4)', marginTop: 'auto' }}>
        {/* ED: replace with final copy */}
        <Link to="/weather" style={linkStyle}>View weather</Link>
        {weather.station === null && (
          <Link to="/weather?connect=station" style={{ ...linkStyle, fontWeight: 400, color: 'var(--c-text-2)' }}>
            {/* ED: replace with final copy */}
            Connect your own station
          </Link>
        )}
      </div>
    </section>
  );
}

import { Link } from 'react-router-dom';
import type { PaidMetrics } from '../../types/metrics';
import { bodyTextStyle, cardStyle, cardTitleStyle, linkStyle, secondaryTextStyle } from './styles';

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

function formatSync(iso: string): string | null {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : SYNC_FORMAT.format(d);
}

// The account's primary weather station connection.
export default function WeatherCard({ weather }: { weather: PaidMetrics['weather'] }) {
  const synced = weather.lastSuccessfulSync ? formatSync(weather.lastSuccessfulSync) : null;
  const provider = weather.provider ? PROVIDER_LABEL[weather.provider] ?? weather.provider : null;
  return (
    <section aria-labelledby="metrics-weather-title" style={cardStyle}>
      {/* ED: replace with final copy */}
      <h2 id="metrics-weather-title" style={cardTitleStyle}>Weather</h2>
      {weather.connected ? (
        <>
          {/* ED: replace with final copy */}
          <p style={bodyTextStyle}>{provider ? `Connected to ${provider}.` : 'Weather station connected.'}</p>
          <p style={{ ...secondaryTextStyle, margin: 0 }}>
            {/* ED: replace with final copy */}
            {synced ? `Last synced ${synced}` : 'Not synced yet'}
          </p>
          {/* ED: replace with final copy */}
          <Link to="/weather" style={{ ...linkStyle, alignSelf: 'flex-start', marginTop: 'auto' }}>View weather</Link>
        </>
      ) : (
        <Link to="/weather" style={{ ...linkStyle, alignSelf: 'flex-start' }}>Connect a weather station</Link>
      )}
    </section>
  );
}

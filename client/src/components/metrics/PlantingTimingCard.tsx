import { Link } from 'react-router-dom';
import { formatRange } from '../../lib/guideDates';
import type { MetricsGarden, TimingRow } from '../../types/metrics';
import {
  bodyTextStyle,
  cardStyle,
  cardTitleStyle,
  dotStyle,
  linkStyle,
  listStyle,
  plantKeyOf,
  plantName,
  secondaryTextStyle,
  shortDate,
  STATUS_COLOR,
} from './styles';

function timingLabel(t: Pick<TimingRow, 'status' | 'weeks'>): string {
  if (t.status === 'on_time') return 'Sowed on time';
  const weeks = `${t.weeks} ${t.weeks === 1 ? 'week' : 'weeks'}`;
  return t.status === 'early' ? `Sowed ${weeks} early` : `Sowed ${weeks} late`;
}

const WINDOW_LABEL: Record<TimingRow['window']['name'], string> = {
  // ED: replace with final copy
  indoorStart: 'Start indoors',
  // ED: replace with final copy
  directSow: 'Direct sow',
};

interface Props {
  timing: TimingRow[];
  gardens: MetricsGarden[];
}

// How each plant's sowing compared with its recommended window.
export default function PlantingTimingCard({ timing, gardens }: Props) {
  const showGarden = gardens.length > 1;
  return (
    <section aria-labelledby="metrics-timing-title" style={cardStyle}>
      {/* ED: replace with final copy */}
      <h2 id="metrics-timing-title" style={cardTitleStyle}>Planting timing</h2>
      {timing.length === 0 ? (
        <>
          <p style={bodyTextStyle}>
            Log your first planting in the planting guide and we&rsquo;ll show you how your timing compared to the recommendations.
          </p>
          <Link to="/guide" style={{ ...linkStyle, alignSelf: 'flex-start' }}>View planting guide</Link>
        </>
      ) : (
        <ul style={{ ...listStyle, gap: 'var(--sp-3)' }}>
          {timing.map((t) => {
            const garden = showGarden ? gardens.find((g) => g.id === t.gardenId)?.name : null;
            return (
              <li key={`${t.gardenId}:${plantKeyOf(t)}`} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-1)', fontSize: 14 }}>
                <span style={{ fontWeight: 600, color: 'var(--c-text)', overflowWrap: 'anywhere' }}>
                  {plantName(t.commonName)}
                  {garden && <span style={{ ...secondaryTextStyle, fontWeight: 400 }}> · {garden}</span>}
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)', color: 'var(--c-text-2)' }}>
                  <span aria-hidden="true" style={dotStyle(STATUS_COLOR[t.status])} />
                  {timingLabel(t)}
                </span>
                <span style={secondaryTextStyle}>
                  {/* ED: replace with final copy */}
                  Sowed {shortDate(t.sowDate)} · {WINDOW_LABEL[t.window.name]} {formatRange(t.window.start, t.window.end)}
                </span>
                {t.sowDateSource === 'marked_done' && (
                  <span style={{ ...secondaryTextStyle, fontStyle: 'italic' }}>based on when you marked it done</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

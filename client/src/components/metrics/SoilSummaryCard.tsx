import { Link } from 'react-router-dom';
import type { MetricsGarden, SoilRow, SoilStatus } from '../../types/metrics';
import {
  bodyTextStyle,
  cardStyle,
  cardTitleStyle,
  dotStyle,
  linkStyle,
  listStyle,
  rowLinkStyle,
  secondaryTextStyle,
  shortDate,
} from './styles';

const STATUS: Record<SoilStatus, { label: string; color: string }> = {
  balanced: { label: 'Balanced', color: 'var(--c-success)' },
  needs_attention: { label: 'Needs attention', color: 'var(--c-warning)' },
  no_ph: { label: 'No pH yet', color: 'var(--c-text-3)' },
};

interface Props {
  soil: SoilRow[];
  gardens: MetricsGarden[];
}

// The latest soil reading this season for each bed that has one.
export default function SoilSummaryCard({ soil, gardens }: Props) {
  const showGarden = gardens.length > 1;
  const firstGarden = gardens[0];
  return (
    <section aria-labelledby="metrics-soil-title" style={cardStyle}>
      {/* ED: replace with final copy */}
      <h2 id="metrics-soil-title" style={cardTitleStyle}>Soil</h2>
      {soil.length === 0 ? (
        <>
          {/* ED: replace with final copy */}
          <p style={bodyTextStyle}>No soil readings this season yet.</p>
          {firstGarden && (
            // ED: replace with final copy
            <Link to={`/garden/${firstGarden.id}/soil`} style={{ ...linkStyle, alignSelf: 'flex-start' }}>Add a soil reading</Link>
          )}
        </>
      ) : (
        <ul style={listStyle}>
          {soil.map((r) => {
            const s = STATUS[r.status];
            return (
              <li key={r.bedId}>
                <Link to={`/garden/${r.gardenId}/soil`} style={{ ...rowLinkStyle, alignItems: 'flex-start' }}>
                  <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                    <span style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>
                      {showGarden ? `${r.gardenName} / ${r.bedLabel}` : r.bedLabel}
                    </span>
                    {/* ED: replace with final copy */}
                    <span style={secondaryTextStyle}>Tested {shortDate(r.testDate)}</span>
                  </span>
                  <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', flexShrink: 0 }}>
                    {r.ph !== null && <span style={{ color: 'var(--c-text)', fontVariantNumeric: 'tabular-nums' }}>pH {r.ph}</span>}
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--sp-2)', fontSize: 13, color: 'var(--c-text-2)' }}>
                      <span aria-hidden="true" style={dotStyle(s.color)} />
                      {s.label}
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

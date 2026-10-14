import { Link } from 'react-router-dom';
import type { MetricsGarden, PaidMetrics } from '../../types/metrics';
import { bodyTextStyle, cardStyle, cardTitleStyle, linkStyle, plural } from './styles';

interface Props {
  amendments: PaidMetrics['amendments'];
  gardens: MetricsGarden[];
}

// Amendment applications this season.
export default function AmendmentSummaryCard({ amendments, gardens }: Props) {
  const firstGarden = gardens[0];
  const { applicationCount, bedCount } = amendments;
  return (
    <section aria-labelledby="metrics-amendments-title" style={cardStyle}>
      {/* ED: replace with final copy */}
      <h2 id="metrics-amendments-title" style={cardTitleStyle}>Amendments</h2>
      {applicationCount === 0 ? (
        // ED: replace with final copy
        <p style={bodyTextStyle}>No amendments logged this season yet.</p>
      ) : (
        <p style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: 'var(--sp-1)' }}>
          <span style={{ fontFamily: 'var(--font-display)', fontSize: 26, fontWeight: 600, color: 'var(--c-text)' }}>
            {/* ED: replace with final copy */}
            {plural(applicationCount, 'application', 'applications')}
          </span>
          <span style={bodyTextStyle}>
            {/* ED: replace with final copy */}
            {bedCount > 0 ? `across ${plural(bedCount, 'bed', 'beds')} this season` : 'this season'}
          </span>
        </p>
      )}
      {firstGarden && (
        <Link to={`/garden/${firstGarden.id}/amendments`} style={{ ...linkStyle, alignSelf: 'flex-start', marginTop: 'auto' }}>
          {/* ED: replace with final copy */}
          View amendment log
        </Link>
      )}
    </section>
  );
}

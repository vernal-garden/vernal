import { Link } from 'react-router-dom';
import { formatQuantity } from '../../hooks/useHarvests';
import type { RecentEntry } from '../../types/metrics';
import {
  bodyTextStyle,
  cardStyle,
  cardTitleStyle,
  linkStyle,
  listStyle,
  plantName,
  rowLinkStyle,
  secondaryTextStyle,
  shortDateWithYear,
} from './styles';

// The latest harvests from any season, newest first.
export default function RecentActivityCard({ recent }: { recent: RecentEntry[] }) {
  return (
    <section aria-labelledby="metrics-recent-title" style={cardStyle}>
      {/* ED: replace with final copy */}
      <h2 id="metrics-recent-title" style={cardTitleStyle}>Recent activity</h2>
      {recent.length === 0 ? (
        // ED: replace with final copy
        <p style={bodyTextStyle}>No harvests logged yet.</p>
      ) : (
        <ul style={listStyle}>
          {recent.map((e) => {
            const quantity = formatQuantity(e.quantity, e.unit);
            const place = e.bedLabel ? `${e.gardenName} / ${e.bedLabel}` : e.gardenName;
            return (
              <li key={e.id}>
                <Link to={`/harvest/${e.id}`} style={{ ...rowLinkStyle, alignItems: 'flex-start' }}>
                  <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                    <span style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{plantName(e.commonName)}</span>
                    <span style={{ ...secondaryTextStyle, overflowWrap: 'anywhere' }}>
                      {shortDateWithYear(e.harvestDate)}
                      {place ? ` · ${place}` : ''}
                    </span>
                  </span>
                  {quantity && (
                    <span style={{ flexShrink: 0, color: 'var(--c-text-2)', fontVariantNumeric: 'tabular-nums' }}>{quantity}</span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      <Link to="/harvest" style={{ ...linkStyle, alignSelf: 'flex-start', marginTop: 'auto' }}>View full log</Link>
    </section>
  );
}

import { Link } from 'react-router-dom';
import type { Trend, TrendPlant } from '../../types/metrics';
import {
  bodyTextStyle,
  cardStyle,
  cardTitleStyle,
  linkStyle,
  listStyle,
  plantKeyOf,
  plantName,
  secondaryTextStyle,
} from './styles';

// Arrow + words + color: the direction never depends on color alone. Only the
// arrow is colored; the words stay in --c-text-2 so they pass AA contrast.
function trendText(p: TrendPlant): { arrow: string; text: string; color: string } {
  if (p.direction === 'up') return { arrow: '↑', text: `Up ${Math.abs(p.changePct)}%`, color: 'var(--c-success)' };
  if (p.direction === 'down') return { arrow: '↓', text: `Down ${Math.abs(p.changePct)}%`, color: 'var(--c-warning)' };
  return { arrow: '→', text: 'About the same', color: 'var(--c-text-3)' };
}

// Year-over-year yields. Not rendered for state 'hidden'.
export default function TrendCard({ trend }: { trend: Trend }) {
  if (trend.state === 'hidden') return null;
  return (
    <section aria-labelledby="metrics-trend-title" style={cardStyle}>
      {/* ED: replace with final copy */}
      <h2 id="metrics-trend-title" style={cardTitleStyle}>Year over year</h2>
      {trend.state === 'one_season' ? (
        <p style={bodyTextStyle}>
          After your second season, you&rsquo;ll be able to see how your yields compare year over year.
        </p>
      ) : (
        <>
          {trend.comparedSeason !== null && (
            <p style={{ ...secondaryTextStyle, margin: 0 }}>compared with {trend.comparedSeason}</p>
          )}
          {trend.plants.length === 0 ? (
            <p style={bodyTextStyle}>
              {/* ED: replace with final copy */}
              None of this season&rsquo;s plants have totals in the same unit as {trend.comparedSeason ?? 'last season'} yet.
            </p>
          ) : (
            <ul style={{ ...listStyle, gap: 'var(--sp-2)' }}>
              {trend.plants.map((p) => {
                const t = trendText(p);
                return (
                  <li
                    key={plantKeyOf(p) ?? p.commonName}
                    style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 'var(--sp-3)', fontSize: 14 }}
                  >
                    <span style={{ fontWeight: 600, color: 'var(--c-text)', overflowWrap: 'anywhere' }}>{plantName(p.commonName)}</span>
                    <span style={{ flexShrink: 0, fontWeight: 600, color: 'var(--c-text-2)' }}>
                      <span aria-hidden="true" style={{ color: t.color, fontSize: 16 }}>{t.arrow} </span>
                      {t.text}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          <Link to="/data/compare" style={{ ...linkStyle, alignSelf: 'flex-start', marginTop: 'auto' }}>View full comparison</Link>
        </>
      )}
    </section>
  );
}

import { formatQuantity } from '../../hooks/useHarvests';
import type { AdvancedMetrics, TimingStatus } from '../../types/metrics';
import type { HarvestUnit } from '../../types/harvest';
import {
  bodyTextStyle,
  cardStyle,
  cardTitleStyle,
  dotStyle,
  listStyle,
  plantName,
  plural,
  secondaryTextStyle,
  STATUS_COLOR,
  subheadingStyle,
} from './styles';

const HARVEST_STATUS_LABEL: Record<TimingStatus, string> = {
  // ED: replace with final copy
  early: 'Earlier than expected',
  // ED: replace with final copy
  on_time: 'Within the expected range',
  // ED: replace with final copy
  late: 'Later than expected',
};

function perSqFtText(value: number, unit: HarvestUnit | null): string {
  // ED: replace with final copy
  if (unit === 'count') return `${value} ${value === 1 ? 'item' : 'items'} per sq ft`;
  // ED: replace with final copy
  return unit ? `${value} ${unit} per sq ft` : `${value} per sq ft`;
}

const rowStyle = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: 'var(--sp-3)',
  padding: 'var(--sp-1) 0',
  fontSize: 14,
  color: 'var(--c-text)',
} as const;

const blockStyle = { display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)', minWidth: 0 } as const;

interface Props {
  advanced: AdvancedMetrics;
  isMobile: boolean;
}

// Supporter analytics: yield per square foot, best performer, harvest
// frequency and days to harvest. Every number comes from the server.
export default function AdvancedPanel({ advanced, isMobile }: Props) {
  const { yieldPerSqFt, yieldPerSqFtReason, topPerformer, frequency, daysToHarvest } = advanced;
  const top = topPerformer ? formatQuantity(topPerformer.total, topPerformer.unit) : null;

  return (
    <section aria-labelledby="metrics-advanced-title" style={cardStyle}>
      <h2 id="metrics-advanced-title" style={cardTitleStyle}>Advanced analytics</h2>

      {topPerformer && top && (
        <p style={{ ...bodyTextStyle, fontSize: 15, color: 'var(--c-text)' }}>
          Your best performer this season was {plantName(topPerformer.commonName)} — {top} across{' '}
          {plural(topPerformer.entryCount, 'harvest', 'harvests')}.
        </p>
      )}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: isMobile ? 'minmax(0, 1fr)' : 'repeat(3, minmax(0, 1fr))',
          gap: 'var(--sp-5)',
        }}
      >
        <div style={blockStyle}>
          {/* ED: replace with final copy */}
          <h3 style={subheadingStyle}>Yield per square foot</h3>
          {yieldPerSqFtReason === 'no_bed_data' || yieldPerSqFt.length === 0 ? (
            <p style={bodyTextStyle}>Add bed dimensions in your garden canvas to see yield per square foot.</p>
          ) : (
            <ul style={listStyle}>
              {yieldPerSqFt.map((y, i) => (
                <li key={`${y.seedId ?? y.cambiumSeedId ?? i}`} style={rowStyle}>
                  <span style={{ overflowWrap: 'anywhere' }}>{plantName(y.commonName)}</span>
                  <span style={{ flexShrink: 0, color: 'var(--c-text-2)', fontVariantNumeric: 'tabular-nums' }}>
                    {perSqFtText(y.perSqFt, y.unit)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div style={blockStyle}>
          {/* ED: replace with final copy */}
          <h3 style={subheadingStyle}>Harvest frequency</h3>
          {frequency.length === 0 ? (
            // ED: replace with final copy
            <p style={bodyTextStyle}>Once a plant has two or more harvests, you&rsquo;ll see how often you picked it.</p>
          ) : (
            <ul style={listStyle}>
              {frequency.map((f, i) => (
                <li key={`${f.commonName}-${i}`} style={{ ...rowStyle, flexDirection: 'column', alignItems: 'flex-start', gap: 0 }}>
                  <span style={{ overflowWrap: 'anywhere' }}>{plantName(f.commonName)}</span>
                  <span style={secondaryTextStyle}>
                    {/* ED: replace with final copy */}
                    Every {f.avgDaysBetween} {f.avgDaysBetween === 1 ? 'day' : 'days'} on average · {plural(f.entryCount, 'harvest', 'harvests')}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div style={blockStyle}>
          {/* ED: replace with final copy */}
          <h3 style={subheadingStyle}>Days to harvest</h3>
          {daysToHarvest.length === 0 ? (
            <p style={bodyTextStyle}>
              {/* ED: replace with final copy */}
              When a sown plant with a known maturity range is harvested, you&rsquo;ll see how it compared.
            </p>
          ) : (
            <ul style={listStyle}>
              {daysToHarvest.map((d, i) => (
                <li key={`${d.commonName}-${i}`} style={{ ...rowStyle, flexDirection: 'column', alignItems: 'flex-start', gap: 0 }}>
                  <span style={{ overflowWrap: 'anywhere' }}>{plantName(d.commonName)}</span>
                  <span style={{ fontSize: 13, color: 'var(--c-text-2)' }}>
                    {d.actualDays} days (expected {d.predictedMin}–{d.predictedMax})
                  </span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--sp-2)', fontSize: 13, color: 'var(--c-text-2)' }}>
                    <span aria-hidden="true" style={dotStyle(STATUS_COLOR[d.status])} />
                    {HARVEST_STATUS_LABEL[d.status]}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

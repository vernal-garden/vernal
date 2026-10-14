import type { WeatherInsight } from '../../types/weather';
import type { UnitSystem } from '../../lib/units';
import { formatInsight } from '../../lib/weatherInsights';

interface Props {
  insights: WeatherInsight[];
  units: UnitSystem;
}

export default function GrowingInsights({ insights, units }: Props) {
  if (insights.length === 0) return null;

  return (
    <div>
      <h3
        style={{
          margin: '0 0 var(--sp-2)',
          fontFamily: 'var(--font-display)',
          fontSize: 16,
          color: 'var(--c-text)',
        }}
      >
        Growing insights
      </h3>
      <ul
        style={{
          margin: 0,
          paddingLeft: 'var(--sp-4)',
          fontFamily: 'var(--font-ui)',
          fontSize: 13,
          color: 'var(--c-text-2)',
          lineHeight: 1.7,
        }}
      >
        {insights.map((insight, i) => (
          <li key={i}>{formatInsight(insight, units)}</li>
        ))}
      </ul>
      <p
        style={{
          margin: 'var(--sp-2) 0 0',
          fontFamily: 'var(--font-ui)',
          fontSize: 11,
          color: 'var(--c-text-3)',
          fontStyle: 'italic',
        }}
      >
        Based on recent conditions — not a forecast.
      </p>
    </div>
  );
}

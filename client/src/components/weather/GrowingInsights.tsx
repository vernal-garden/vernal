import type { HistoryPoint } from '../../hooks/useWeather';
import { formatPrecip, formatTemp, UnitSystem } from '../../lib/units';

const DRY_SPELL_THRESHOLD_MM = 5;
const FROST_RISK_THRESHOLD_C = 2;
const TEMP_SWING_THRESHOLD_C = 8;
const TREND_THRESHOLD_C = 3;

interface Props {
  history: HistoryPoint[];
  units: UnitSystem;
}

function buildInsights(history: HistoryPoint[], units: UnitSystem): string[] {
  const insights: string[] = [];
  const sorted = [...history].sort((a, b) => a.date.localeCompare(b.date));

  // 1. Dry spell — 7-day precip sum
  const precipDays = sorted.filter((h) => h.precipMm !== null);
  if (precipDays.length >= 3) {
    const sumMm = precipDays.reduce((acc, h) => acc + (h.precipMm as number), 0);
    if (sumMm < DRY_SPELL_THRESHOLD_MM) {
      insights.push(
        `It's been dry — only ${formatPrecip(sumMm, units)} of rain over the last ${precipDays.length} days. Keep an eye on soil moisture.`,
      );
    }
  }

  // 2. Temp trend / range from highs and lows
  const highs = sorted.filter((h) => h.tempMaxC !== null).map((h) => h.tempMaxC as number);
  const lows = sorted.filter((h) => h.tempMinC !== null).map((h) => h.tempMinC as number);
  if (highs.length >= 2 && lows.length >= 2) {
    const maxHigh = Math.max(...highs);
    const minLow = Math.min(...lows);
    const swing = maxHigh - minLow;
    const half = Math.floor(highs.length / 2);
    const firstAvg = highs.slice(0, half).reduce((a, b) => a + b, 0) / half;
    const secondAvg = highs.slice(half).reduce((a, b) => a + b, 0) / (highs.length - half);
    const delta = secondAvg - firstAvg;

    if (swing >= TEMP_SWING_THRESHOLD_C) {
      insights.push(
        `Temperatures have swung widely this week — from ${formatTemp(minLow, units)} up to ${formatTemp(maxHigh, units)}.`,
      );
    } else if (delta >= TREND_THRESHOLD_C) {
      insights.push(`Warming trend this week — highs are climbing toward ${formatTemp(maxHigh, units)}.`);
    } else if (delta <= -TREND_THRESHOLD_C) {
      insights.push(`Cooling trend this week — highs have dropped toward ${formatTemp(maxHigh, units)}.`);
    } else {
      insights.push(
        `Fairly steady temperatures this week, in the ${formatTemp(minLow, units)}–${formatTemp(maxHigh, units)} range.`,
      );
    }
  }

  // 3. Frost risk — a recent low near/below freezing
  const recentLows = sorted.slice(-3).filter((h) => h.tempMinC !== null);
  const frostDay = recentLows.find((h) => (h.tempMinC as number) <= FROST_RISK_THRESHOLD_C);
  if (frostDay) {
    insights.push(
      `Frost risk — a recent overnight low near freezing (${formatTemp(frostDay.tempMinC, units)} on ${frostDay.date}). Protect sensitive plants.`,
    );
  }

  return insights.slice(0, 3);
}

export default function GrowingInsights({ history, units }: Props) {
  const insights = buildInsights(history, units);
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
        {insights.map((text, i) => (
          <li key={i}>{text}</li>
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

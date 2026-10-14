import type { WeatherInsight } from '../types/weather';
import { formatPrecip, formatTemp, type UnitSystem } from './units';
import { shortDate } from './guideDates';

export function formatInsight(insight: WeatherInsight, units: UnitSystem): string {
  switch (insight.kind) {
    case 'dry_spell':
      // ED: replace with final copy
      return `It's been dry — only ${formatPrecip(insight.precipMm, units)} of rain over the last ${insight.days} days. Keep an eye on soil moisture.`;
    case 'temp_swing':
      // ED: replace with final copy
      return `Temperatures have swung widely this week — from ${formatTemp(insight.minLowC, units)} up to ${formatTemp(insight.maxHighC, units)}.`;
    case 'warming':
      // ED: replace with final copy
      return `Warming trend this week — highs are climbing toward ${formatTemp(insight.maxHighC, units)}.`;
    case 'cooling':
      // ED: replace with final copy
      return `Cooling trend this week — highs have dropped toward ${formatTemp(insight.maxHighC, units)}.`;
    case 'steady':
      // ED: replace with final copy
      return `Fairly steady temperatures this week, in the ${formatTemp(insight.minLowC, units)}–${formatTemp(insight.maxHighC, units)} range.`;
    case 'frost_risk':
      // ED: replace with final copy
      return `Frost risk — a recent overnight low near freezing (${formatTemp(insight.lowC, units)} on ${shortDate(insight.date)}). Protect sensitive plants.`;
  }
}

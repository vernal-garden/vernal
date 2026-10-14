import type { DailyHistoryPoint } from './types';

const DRY_SPELL_THRESHOLD_MM = 5;
const FROST_RISK_THRESHOLD_C = 2;
const TEMP_SWING_THRESHOLD_C = 8;
const TREND_THRESHOLD_C = 3;

export type WeatherInsight =
  | { kind: 'dry_spell'; precipMm: number; days: number }
  | { kind: 'temp_swing'; minLowC: number; maxHighC: number }
  | { kind: 'warming'; maxHighC: number }
  | { kind: 'cooling'; maxHighC: number }
  | { kind: 'steady'; minLowC: number; maxHighC: number }
  | { kind: 'frost_risk'; lowC: number; date: string };

export interface WeekSummary {
  minLowC: number;
  maxHighC: number;
  precipMm: number;
  days: number; // number of history points considered
}

function sortByDate(history: DailyHistoryPoint[]): DailyHistoryPoint[] {
  return [...history].sort((a, b) => a.date.localeCompare(b.date));
}

export function buildInsights(history: DailyHistoryPoint[]): WeatherInsight[] {
  const insights: WeatherInsight[] = [];
  const sorted = sortByDate(history);

  // 1. Dry spell: precipitation sum over the window
  const precipDays = sorted.filter((h) => h.precipMm !== null);
  if (precipDays.length >= 3) {
    const sumMm = precipDays.reduce((acc, h) => acc + (h.precipMm as number), 0);
    if (sumMm < DRY_SPELL_THRESHOLD_MM) {
      insights.push({ kind: 'dry_spell', precipMm: sumMm, days: precipDays.length });
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
      insights.push({ kind: 'temp_swing', minLowC: minLow, maxHighC: maxHigh });
    } else if (delta >= TREND_THRESHOLD_C) {
      insights.push({ kind: 'warming', maxHighC: maxHigh });
    } else if (delta <= -TREND_THRESHOLD_C) {
      insights.push({ kind: 'cooling', maxHighC: maxHigh });
    } else {
      insights.push({ kind: 'steady', minLowC: minLow, maxHighC: maxHigh });
    }
  }

  // 3. Frost risk: a recent low near/below freezing
  const recentLows = sorted.slice(-3).filter((h) => h.tempMinC !== null);
  const frostDay = recentLows.find((h) => (h.tempMinC as number) <= FROST_RISK_THRESHOLD_C);
  if (frostDay) {
    insights.push({ kind: 'frost_risk', lowC: frostDay.tempMinC as number, date: frostDay.date });
  }

  return insights.slice(0, 3);
}

export function weekSummary(history: DailyHistoryPoint[]): WeekSummary | null {
  const highs = history.filter((h) => h.tempMaxC !== null).map((h) => h.tempMaxC as number);
  const lows = history.filter((h) => h.tempMinC !== null).map((h) => h.tempMinC as number);
  if (highs.length < 2 || lows.length < 2) return null;
  const precipMm = history.reduce((acc, h) => acc + (h.precipMm ?? 0), 0);
  return {
    minLowC: Math.min(...lows),
    maxHighC: Math.max(...highs),
    precipMm,
    days: history.length,
  };
}

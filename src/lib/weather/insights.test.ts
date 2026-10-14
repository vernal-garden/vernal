import { describe, it, expect } from 'vitest';
import { buildInsights, weekSummary } from './insights';
import type { DailyHistoryPoint } from './types';

function pt(date: string, hi: number | null, lo: number | null, p: number | null): DailyHistoryPoint {
  return { date, tempMaxC: hi, tempMinC: lo, precipMm: p };
}

// Wet, steady, no frost: baseline producing only the 'steady' insight.
function steady(): DailyHistoryPoint[] {
  return [
    pt('2026-10-01', 15, 8, 5),
    pt('2026-10-02', 15, 8, 5),
    pt('2026-10-03', 15, 8, 5),
    pt('2026-10-04', 15, 8, 5),
  ];
}

describe('buildInsights', () => {
  it('dry_spell when 3+ precip days sum under 5mm', () => {
    const h = steady().map((p) => ({ ...p, precipMm: 1 }));
    expect(buildInsights(h)[0]).toEqual({ kind: 'dry_spell', precipMm: 4, days: 4 });
  });

  it('no dry_spell with fewer than 3 precip days', () => {
    const h = [pt('2026-10-01', 15, 8, 0), pt('2026-10-02', 15, 8, 0), pt('2026-10-03', 15, 8, null)];
    expect(buildInsights(h).some((i) => i.kind === 'dry_spell')).toBe(false);
  });

  it('temp_swing when range >= 8', () => {
    const h = [pt('2026-10-01', 20, 10, 5), pt('2026-10-02', 20, 10, 5), pt('2026-10-03', 20, 10, 5)];
    expect(buildInsights(h)).toEqual([{ kind: 'temp_swing', minLowC: 10, maxHighC: 20 }]);
  });

  it('warming when second-half highs rise by 3+', () => {
    const h = [pt('2026-10-01', 12, 10, 5), pt('2026-10-02', 12, 10, 5), pt('2026-10-03', 16, 10, 5), pt('2026-10-04', 16, 10, 5)];
    expect(buildInsights(h)).toEqual([{ kind: 'warming', maxHighC: 16 }]);
  });

  it('cooling when second-half highs drop by 3+', () => {
    const h = [pt('2026-10-01', 16, 10, 5), pt('2026-10-02', 16, 10, 5), pt('2026-10-03', 12, 10, 5), pt('2026-10-04', 12, 10, 5)];
    expect(buildInsights(h)).toEqual([{ kind: 'cooling', maxHighC: 16 }]);
  });

  it('steady otherwise', () => {
    expect(buildInsights(steady())).toEqual([{ kind: 'steady', minLowC: 8, maxHighC: 15 }]);
  });

  it('frost_risk from a recent low <= 2', () => {
    const h = steady();
    h[3] = pt('2026-10-04', 15, 1, 5);
    const out = buildInsights(h);
    expect(out[out.length - 1]).toEqual({ kind: 'frost_risk', lowC: 1, date: '2026-10-04' });
  });

  it('caps at 3 in order dry, temp, frost', () => {
    const h = [pt('2026-10-01', 20, 0, 0), pt('2026-10-02', 20, 0, 0), pt('2026-10-03', 20, 0, 0)];
    const out = buildInsights(h);
    expect(out.map((i) => i.kind)).toEqual(['dry_spell', 'temp_swing', 'frost_risk']);
    expect(out.length).toBeLessThanOrEqual(3);
  });

  it('sorts unsorted input by date', () => {
    const h = [pt('2026-10-03', 16, 10, 5), pt('2026-10-01', 12, 10, 5), pt('2026-10-04', 16, 10, 5), pt('2026-10-02', 12, 10, 5)];
    expect(buildInsights(h)).toEqual([{ kind: 'warming', maxHighC: 16 }]);
  });
});

describe('weekSummary', () => {
  it('summarises min low, max high, precip sum, point count', () => {
    const h = [pt('2026-10-01', 12, 3, 1.5), pt('2026-10-02', 18, 5, null), pt('2026-10-03', 15, 2, 2)];
    expect(weekSummary(h)).toEqual({ minLowC: 2, maxHighC: 18, precipMm: 3.5, days: 3 });
  });

  it('null with fewer than 2 highs or 2 lows', () => {
    expect(weekSummary([pt('2026-10-01', 12, 3, 0)])).toBeNull();
    expect(weekSummary([pt('2026-10-01', 12, 3, 0), pt('2026-10-02', 14, null, 0)])).toBeNull();
    expect(weekSummary([])).toBeNull();
  });
});

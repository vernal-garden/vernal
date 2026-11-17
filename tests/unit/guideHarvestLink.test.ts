import { describe, it, expect } from 'vitest';
import { canLogHarvest } from '../../client/src/lib/guideModel';
import type { GuideRow } from '../../client/src/types/plantingGuide';

function row(extra: Partial<GuideRow> = {}): GuideRow {
  return {
    gardenId: '1',
    seedId: '10',
    cambiumSeedId: null,
    commonName: 'Tomato',
    scientificName: null,
    plantFamily: null,
    plantingCount: 1,
    successionIntervalWeeks: null,
    frostTolerance: 'none',
    weeksToTransplant: null,
    maturityDaysMin: 60,
    maturityDaysMax: 80,
    overrides: null,
    done: { sowingEventId: '5', markedDoneAt: '2026-04-01T17:00:00.000Z' },
    windows: {
      indoorStart: null,
      transplant: null,
      directSow: { start: '2026-04-01', end: '2026-04-30', source: 'zone_estimate' },
      harvest: { start: '2026-06-01', end: '2026-07-31', source: 'zone_estimate' },
    },
    missingReason: null,
    ...extra,
  };
}

describe('canLogHarvest', () => {
  it('is false when the plant is not done', () => {
    expect(canLogHarvest(row({ done: null }), '2026-06-15', false)).toBe(false);
    expect(canLogHarvest(row({ done: { sowingEventId: '5', markedDoneAt: null } }), '2026-06-15', false)).toBe(false);
  });

  it('is false before the harvest window opens', () => {
    expect(canLogHarvest(row(), '2026-05-31', false)).toBe(false);
  });

  it('is true on the first day of the harvest window and after', () => {
    expect(canLogHarvest(row(), '2026-06-01', false)).toBe(true);
    expect(canLogHarvest(row(), '2026-08-15', false)).toBe(true);
  });

  it('is false with no harvest window', () => {
    const r = row();
    expect(canLogHarvest(row({ windows: { ...r.windows, harvest: null } }), '2026-06-15', false)).toBe(false);
  });

  it('is false when the guide is read-only', () => {
    expect(canLogHarvest(row(), '2026-06-15', true)).toBe(false);
  });
});

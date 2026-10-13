import { describe, it, expect } from 'vitest';
import {
  computeWindows,
  currentSeason,
  type FrostContext,
  type Overrides,
  type Timing,
} from './plantingSchedule';

const NO_OVERRIDES: Overrides = { indoorStart: null, transplant: null, directSow: null };
const ZONE_FROST: FrostContext = {
  lastSpringFrost: '2027-04-11',
  frostSource: 'zone_estimate',
  frostFree: false,
};
const TOMATO: Timing = {
  weeksToTransplant: 6,
  frostTolerance: 'none',
  maturityDaysMin: 60,
  maturityDaysMax: 80,
};
const PEA: Timing = {
  weeksToTransplant: null,
  frostTolerance: 'hard',
  maturityDaysMin: null,
  maturityDaysMax: null,
};

describe('computeWindows', () => {
  it('derives indoor, transplant and harvest windows for a transplanted seed', () => {
    const w = computeWindows(TOMATO, NO_OVERRIDES, ZONE_FROST, 2027);
    expect(w.indoorStart).toEqual({ start: '2027-02-21', end: '2027-03-07', source: 'zone_estimate' });
    expect(w.transplant).toEqual({ start: '2027-04-18', end: '2027-05-02', source: 'zone_estimate' });
    expect(w.directSow).toBeNull();
    expect(w.harvest).toEqual({ start: '2027-06-17', end: '2027-07-07', source: 'zone_estimate' });
    expect(w.missingReason).toBeNull();
  });

  it('derives only a direct-sow window for a seed with no weeksToTransplant', () => {
    const w = computeWindows(PEA, NO_OVERRIDES, ZONE_FROST, 2027);
    expect(w.directSow).toEqual({ start: '2027-02-28', end: '2027-03-28', source: 'zone_estimate' });
    expect(w.indoorStart).toBeNull();
    expect(w.transplant).toBeNull();
    expect(w.harvest).toBeNull();
  });

  it('treats an unknown tolerance as none', () => {
    const unknown = computeWindows({ ...TOMATO, frostTolerance: 'semi' }, NO_OVERRIDES, ZONE_FROST, 2027);
    const none = computeWindows(TOMATO, NO_OVERRIDES, ZONE_FROST, 2027);
    expect(unknown).toEqual(none);
  });

  it('applies an override from another year to the viewed season and anchors harvest on it', () => {
    const w = computeWindows(
      TOMATO,
      { ...NO_OVERRIDES, transplant: '2026-05-10' },
      { ...ZONE_FROST, frostSource: 'account_frost' },
      2027,
    );
    expect(w.transplant).toEqual({ start: '2027-05-10', end: '2027-05-10', source: 'custom' });
    expect(w.harvest).toEqual({ start: '2027-07-09', end: '2027-07-29', source: 'custom' });
    expect(w.indoorStart?.source).toBe('account_frost');
  });

  it('reports no_frost_date with null windows when there is no frost date', () => {
    const w = computeWindows(
      TOMATO,
      NO_OVERRIDES,
      { lastSpringFrost: null, frostSource: null, frostFree: false },
      2027,
    );
    expect(w).toEqual({
      indoorStart: null,
      transplant: null,
      directSow: null,
      harvest: null,
      missingReason: 'no_frost_date',
    });
  });

  it('reports no_timing_data and invents no direct-sow window for an empty record', () => {
    const empty: Timing = {
      weeksToTransplant: null,
      frostTolerance: null,
      maturityDaysMin: null,
      maturityDaysMax: null,
    };
    const w = computeWindows(empty, NO_OVERRIDES, ZONE_FROST, 2027);
    expect(w.missingReason).toBe('no_timing_data');
    expect(w.directSow).toBeNull();
  });

  it('shows a direct-sow override for a frost-free garden and clears missingReason', () => {
    const w = computeWindows(
      PEA,
      { ...NO_OVERRIDES, directSow: '2027-01-15' },
      { lastSpringFrost: null, frostSource: null, frostFree: true },
      2027,
    );
    expect(w.directSow).toEqual({ start: '2027-01-15', end: '2027-01-15', source: 'custom' });
    expect(w.missingReason).toBeNull();
  });

  it('reports frost_free when there are no overrides', () => {
    const w = computeWindows(
      PEA,
      NO_OVERRIDES,
      { lastSpringFrost: null, frostSource: null, frostFree: true },
      2027,
    );
    expect(w.missingReason).toBe('frost_free');
  });
});

describe('currentSeason', () => {
  it('uses the Los Angeles calendar year', () => {
    expect(currentSeason(new Date('2027-01-01T06:00:00Z'))).toBe(2026);
    expect(currentSeason(new Date('2027-01-01T09:00:00Z'))).toBe(2027);
  });
});

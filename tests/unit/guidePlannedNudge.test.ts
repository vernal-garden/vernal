import { describe, it, expect } from 'vitest';
import { isDone, plannedNudge, rowHasPlanned } from '../../client/src/lib/guideModel';
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
    done: null,
    windows: {
      indoorStart: { start: '2027-03-01', end: '2027-04-15', source: 'zone_estimate' },
      transplant: null,
      directSow: { start: '2027-04-01', end: '2027-04-20', source: 'zone_estimate' },
      harvest: { start: '2027-06-01', end: '2027-07-31', source: 'zone_estimate' },
    },
    missingReason: null,
    ...extra,
  };
}

const planned = [{ gardenId: '1', seedId: '10', cambiumSeedId: null, state: 'planned' as const }];

describe('plannedNudge', () => {
  it('open window', () => {
    expect(plannedNudge(row(), planned, '2027-03-10', false)).toEqual({
      kind: 'indoorStart',
      closing: false,
      endsOn: '2027-04-15',
    });
  });

  it('closing within 7 days wins by earliest end', () => {
    const n = plannedNudge(row(), planned, '2027-04-12', false);
    expect(n).toEqual({ kind: 'indoorStart', closing: true, endsOn: '2027-04-15' });
  });

  it('no planned plantings', () => {
    const growing = [{ ...planned[0], state: 'growing' as const }];
    expect(plannedNudge(row(), growing, '2027-03-10', false)).toBeNull();
    expect(rowHasPlanned(row(), growing)).toBe(false);
    expect(rowHasPlanned(row(), planned)).toBe(true);
  });

  it('read-only', () => {
    expect(plannedNudge(row(), planned, '2027-03-10', true)).toBeNull();
  });

  it('no open window', () => {
    expect(plannedNudge(row(), planned, '2027-05-10', false)).toBeNull();
  });

  it('matches cambium rows by cambiumSeedId', () => {
    const r = row({ seedId: null, cambiumSeedId: '7' });
    const p = [{ gardenId: '1', seedId: null, cambiumSeedId: '7', state: 'planned' as const }];
    expect(plannedNudge(r, p, '2027-03-10', false)?.kind).toBe('indoorStart');
  });
});

describe('isDone', () => {
  const now = new Date('2027-03-01T00:00:00Z');
  it('future markedDoneAt is not done', () => {
    expect(isDone(row({ done: { sowingEventId: '1', markedDoneAt: '2027-03-05T00:00:00Z' } }), now)).toBe(false);
  });
  it('past markedDoneAt is done', () => {
    expect(isDone(row({ done: { sowingEventId: '1', markedDoneAt: '2027-02-20T00:00:00Z' } }), now)).toBe(true);
  });
  it('null done is not done', () => {
    expect(isDone(row({ done: null }), now)).toBe(false);
  });
});

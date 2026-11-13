import { describe, it, expect } from 'vitest';
import { estimateFrostDates, resolveFrostContext } from './frostDates';

describe('estimateFrostDates', () => {
  it('maps zone 6b to the zone 6 dates in the given season', () => {
    expect(estimateFrostDates('6b', 2027)).toEqual({
      lastSpringFrost: '2027-04-24',
      firstFallFrost: '2027-10-24',
      frostFree: false,
      parsed: true,
      basis: 'noaa',
    });
  });

  it('parses a leading integer after whitespace', () => {
    expect(estimateFrostDates(' 9a', 2026).lastSpringFrost).toBe('2026-02-12');
  });

  it('every zone 3-9 spring date is the NOAA median', () => {
    const expected: Record<string, string> = {
      '3': '05-18',
      '4': '05-13',
      '5': '05-04',
      '6': '04-24',
      '7': '04-07',
      '8': '03-20',
      '9': '02-12',
    };
    for (const [zone, spring] of Object.entries(expected)) {
      const est = estimateFrostDates(`${zone}a`, 2027);
      expect(est.lastSpringFrost).toBe(`2027-${spring}`);
      expect(est.basis).toBe('noaa');
    }
  });

  it('zones 1 and 2 keep their dates with basis rough', () => {
    const zone2 = estimateFrostDates('2b', 2027);
    expect(zone2.lastSpringFrost).toBe('2027-05-18');
    expect(zone2.basis).toBe('rough');
    const zone1 = estimateFrostDates('1a', 2027);
    expect(zone1.lastSpringFrost).toBe('2027-05-28');
    expect(zone1.basis).toBe('rough');
  });

  it('treats zones 10 and up as frost-free', () => {
    expect(estimateFrostDates('10a', 2027)).toEqual({
      lastSpringFrost: null,
      firstFallFrost: null,
      frostFree: true,
      parsed: true,
      basis: null,
    });
  });

  it('reports parsed false for an unparseable or out-of-range zone', () => {
    const unparsed = { lastSpringFrost: null, firstFallFrost: null, frostFree: false, parsed: false, basis: null };
    expect(estimateFrostDates('zone x', 2027)).toEqual(unparsed);
    expect(estimateFrostDates('0', 2027)).toEqual(unparsed);
    expect(estimateFrostDates('14a', 2027)).toEqual(unparsed);
  });
});

describe('resolveFrostContext', () => {
  it('uses the account dates moved onto the season when the account has a last frost', () => {
    expect(resolveFrostContext({ last: '2024-04-20', first: '2024-10-15' }, '6b', 2027)).toEqual({
      lastSpringFrost: '2027-04-20',
      firstFallFrost: '2027-10-15',
      frostSource: 'account_frost',
      frostFree: false,
      frostBasis: null,
      stationName: null,
    });
  });

  it('leaves the fall frost null when the account has none', () => {
    const ctx = resolveFrostContext({ last: '2024-04-20', first: null }, '6b', 2027);
    expect(ctx.firstFallFrost).toBeNull();
    expect(ctx.frostSource).toBe('account_frost');
    expect(ctx.frostBasis).toBeNull();
    expect(ctx.stationName).toBeNull();
  });

  it('falls back to the zone estimate without account dates', () => {
    expect(resolveFrostContext(null, '6b', 2027)).toEqual({
      lastSpringFrost: '2027-04-24',
      firstFallFrost: '2027-10-24',
      frostSource: 'zone_estimate',
      frostFree: false,
      frostBasis: 'noaa',
      stationName: null,
    });
  });

  it('reports frost-free for zones 10 and up, with no source', () => {
    expect(resolveFrostContext(null, '10a', 2027)).toEqual({
      lastSpringFrost: null,
      firstFallFrost: null,
      frostSource: null,
      frostFree: true,
      frostBasis: null,
      stationName: null,
    });
  });

  it('gives no source for an unparseable zone', () => {
    expect(resolveFrostContext(null, 'zone x', 2027)).toEqual({
      lastSpringFrost: null,
      firstFallFrost: null,
      frostSource: null,
      frostFree: false,
      frostBasis: null,
      stationName: null,
    });
  });

  const spokane = { name: 'Spokane Intl Airport', p50: '04-26', freezePct: 100 };

  it("uses the station's median spring date and the zone's fall date", () => {
    expect(resolveFrostContext(null, '6b', 2027, spokane)).toEqual({
      lastSpringFrost: '2027-04-26',
      firstFallFrost: '2027-10-24',
      frostSource: 'zone_estimate',
      frostFree: false,
      frostBasis: 'station',
      stationName: 'Spokane Intl Airport',
    });
  });

  it('reports frost-free, with no dates, for a station that freezes in under half of years', () => {
    const borrego = { name: 'Borrego Desert Park', p50: '01-10', freezePct: 44.6 };
    expect(resolveFrostContext(null, '9b', 2027, borrego)).toEqual({
      lastSpringFrost: null,
      firstFallFrost: null,
      frostSource: null,
      frostFree: true,
      frostBasis: 'station',
      stationName: 'Borrego Desert Park',
    });
  });

  it('dates a zone 10 garden from its station, with no fall date', () => {
    const station = { name: 'Some Station', p50: '01-20', freezePct: 60 };
    expect(resolveFrostContext(null, '10a', 2027, station)).toEqual({
      lastSpringFrost: '2027-01-20',
      firstFallFrost: null,
      frostSource: 'zone_estimate',
      frostFree: false,
      frostBasis: 'station',
      stationName: 'Some Station',
    });
  });

  it('ignores the station when the account has its own dates', () => {
    expect(resolveFrostContext({ last: '2024-04-20', first: '2024-10-15' }, '6b', 2027, spokane)).toEqual({
      lastSpringFrost: '2027-04-20',
      firstFallFrost: '2027-10-15',
      frostSource: 'account_frost',
      frostFree: false,
      frostBasis: null,
      stationName: null,
    });
  });
});

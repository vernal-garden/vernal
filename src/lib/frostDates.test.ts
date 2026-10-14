import { describe, it, expect } from 'vitest';
import { estimateFrostDates, resolveFrostContext } from './frostDates';

describe('estimateFrostDates', () => {
  it('maps zone 6b to the zone 6 midpoints in the given season', () => {
    expect(estimateFrostDates('6b', 2027)).toEqual({
      lastSpringFrost: '2027-04-11',
      firstFallFrost: '2027-10-24',
      frostFree: false,
      parsed: true,
    });
  });

  it('parses a leading integer after whitespace', () => {
    expect(estimateFrostDates(' 9a', 2026).lastSpringFrost).toBe('2026-02-17');
  });

  it('treats zones 10 and up as frost-free', () => {
    expect(estimateFrostDates('10a', 2027)).toEqual({
      lastSpringFrost: null,
      firstFallFrost: null,
      frostFree: true,
      parsed: true,
    });
  });

  it('reports parsed false for an unparseable or out-of-range zone', () => {
    const unparsed = { lastSpringFrost: null, firstFallFrost: null, frostFree: false, parsed: false };
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
    });
  });

  it('leaves the fall frost null when the account has none', () => {
    const ctx = resolveFrostContext({ last: '2024-04-20', first: null }, '6b', 2027);
    expect(ctx.firstFallFrost).toBeNull();
    expect(ctx.frostSource).toBe('account_frost');
  });

  it('falls back to the zone estimate without account dates', () => {
    expect(resolveFrostContext(null, '6b', 2027)).toEqual({
      lastSpringFrost: '2027-04-11',
      firstFallFrost: '2027-10-24',
      frostSource: 'zone_estimate',
      frostFree: false,
    });
  });

  it('reports frost-free for zones 10 and up, with no source', () => {
    expect(resolveFrostContext(null, '10a', 2027)).toEqual({
      lastSpringFrost: null,
      firstFallFrost: null,
      frostSource: null,
      frostFree: true,
    });
  });

  it('gives no source for an unparseable zone', () => {
    expect(resolveFrostContext(null, 'zone x', 2027)).toEqual({
      lastSpringFrost: null,
      firstFallFrost: null,
      frostSource: null,
      frostFree: false,
    });
  });
});

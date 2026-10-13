import { describe, it, expect } from 'vitest';
import { estimateFrostDates } from './frostDates';

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

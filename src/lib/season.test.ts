import { describe, it, expect } from 'vitest';
import { currentSeason, seasonOf, todayPacific } from './season';

describe('todayPacific', () => {
  it('gives the previous Pacific day just after midnight UTC', () => {
    expect(todayPacific(new Date('2026-03-15T00:30:00Z'))).toBe('2026-03-14');
  });

  it('gives the same day in the Pacific afternoon', () => {
    expect(todayPacific(new Date('2026-07-04T20:00:00Z'))).toBe('2026-07-04');
  });

  it('pads month and day', () => {
    expect(todayPacific(new Date('2026-02-03T18:00:00Z'))).toBe('2026-02-03');
  });
});

describe('currentSeason', () => {
  it('is still last year on New Year morning UTC', () => {
    expect(currentSeason(new Date('2027-01-01T05:00:00Z'))).toBe(2026);
  });
});

describe('seasonOf', () => {
  it('is the year of the date', () => {
    expect(seasonOf('2026-11-17')).toBe(2026);
  });
});

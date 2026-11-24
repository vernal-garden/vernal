import { describe, it, expect } from 'vitest';
import {
  formatNames,
  formatShortDate,
  markInGround,
  nextSeasonPromptTitle,
  BELL_OPEN_LINE,
  BELL_CLOSING_LINE,
  OVERLAY_NONE,
  SEASON_THIS,
} from '../../client/src/lib/planningStrings';

describe('formatNames', () => {
  it('handles empty, one and two names', () => {
    expect(formatNames([])).toBe('');
    expect(formatNames(['Kale'])).toBe('Kale');
    expect(formatNames(['Kale', 'Leek'])).toBe('Kale and Leek');
  });
  it('joins three and four names with commas and "and"', () => {
    expect(formatNames(['Kale', 'Leek', 'Pea'])).toBe('Kale, Leek and Pea');
    expect(formatNames(['Kale', 'Leek', 'Pea', 'Bean'])).toBe('Kale, Leek, Pea and Bean');
  });
  it('collapses past four names', () => {
    expect(formatNames(['Kale', 'Leek', 'Pea', 'Bean', 'Beet'])).toBe('Kale, Leek, Pea and 2 more');
  });
});

describe('formatShortDate', () => {
  it('omits the year in the viewed season', () => {
    expect(formatShortDate('2027-03-04', 2027)).toBe('Mar 4');
  });
  it('adds the year outside the viewed season', () => {
    expect(formatShortDate('2026-12-15', 2027)).toBe('Dec 15, 2026');
  });
});

describe('strings', () => {
  it('formats counts, titles and bell lines', () => {
    expect(markInGround(3)).toBe('Mark 3 in the ground');
    expect(nextSeasonPromptTitle(2027, 2026)).toBe('Start 2027 with your 2026 beds?');
    expect(BELL_OPEN_LINE.transplant_sown('Kale')).toBe('Started Kale indoors? They can go out now.');
    expect(BELL_CLOSING_LINE.indoor_start('Kale', 'Mar 4')).toBe('Start Kale indoors by Mar 4');
  });
  it('names the overlay-off choice apart from the season switch', () => {
    expect(OVERLAY_NONE).toBe('No overlay');
    expect(OVERLAY_NONE).not.toBe(SEASON_THIS);
  });
});

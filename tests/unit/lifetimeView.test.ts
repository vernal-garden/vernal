import { describe, it, expect } from 'vitest';
import {
  inGroup,
  statusOf,
  statusRank,
  formatWeeks,
  feedbackSplit,
  windowEndDay,
} from '../../client/src/lib/lifetimeView';
import { loadServerConfig } from '../../src/lib/serverConfig';

// grantEligible as the server sets it: qualifies and lives in a US state.
const qualifier = { qualifies: true, borderline: false, residenceState: 'WA', grantEligible: true };
const outside = { qualifies: true, borderline: false, residenceState: 'OUTSIDE_US', grantEligible: false };
const noState = { qualifies: true, borderline: false, residenceState: null, grantEligible: false };
const close = { qualifies: false, borderline: true, residenceState: null, grantEligible: false };
const notYet = { qualifies: false, borderline: false, residenceState: null, grantEligible: false };

describe('inGroup', () => {
  it('all includes every row', () => {
    for (const r of [qualifier, outside, noState, close, notYet]) expect(inGroup(r, 'all')).toBe(true);
  });
  it('qualify, close and notYet split the rows', () => {
    expect(inGroup(qualifier, 'qualify')).toBe(true);
    expect(inGroup(close, 'qualify')).toBe(false);
    expect(inGroup(close, 'close')).toBe(true);
    expect(inGroup(notYet, 'close')).toBe(false);
    expect(inGroup(notYet, 'notYet')).toBe(true);
    expect(inGroup(close, 'notYet')).toBe(false);
    expect(inGroup(qualifier, 'notYet')).toBe(false);
  });
  it('noState is a qualifier with no answer; OUTSIDE_US is an answer', () => {
    expect(inGroup(noState, 'noState')).toBe(true);
    expect(inGroup(outside, 'noState')).toBe(false);
    expect(inGroup(qualifier, 'noState')).toBe(false);
    expect(inGroup(notYet, 'noState')).toBe(false);
  });
  it('eligible is a qualifier with a US state; OUTSIDE_US or no state is not', () => {
    expect(inGroup(qualifier, 'eligible')).toBe(true);
    expect(inGroup(outside, 'eligible')).toBe(false);
    expect(inGroup(noState, 'eligible')).toBe(false);
    expect(inGroup(close, 'eligible')).toBe(false);
    expect(inGroup(notYet, 'eligible')).toBe(false);
  });
});

describe('statusOf and statusRank', () => {
  it('3 weeks and 3 feedback qualifies', () => {
    expect(statusOf(qualifier)).toBe('Qualifies');
    expect(statusRank(qualifier)).toBe(0);
  });
  it('2 weeks and 2 feedback is close', () => {
    expect(statusOf(close)).toBe('Close');
    expect(statusRank(close)).toBe(1);
  });
  it('3 weeks and 2 feedback is not yet', () => {
    expect(statusOf(notYet)).toBe('Not yet');
    expect(statusRank(notYet)).toBe(2);
  });
});

describe('formatWeeks', () => {
  it('shows the month on the first date and when it changes', () => {
    expect(formatWeeks(['2026-12-07', '2026-12-14', '2027-01-04'])).toBe('Dec 7, 14, Jan 4');
  });
  it('formats one date', () => {
    expect(formatWeeks(['2026-12-07'])).toBe('Dec 7');
  });
  it('returns an empty string for none', () => {
    expect(formatWeeks([])).toBe('');
  });
});

describe('feedbackSplit', () => {
  it('lists each non-zero part', () => {
    expect(feedbackSplit({ notes: 2, quickAnswers: 1, surveys: 1 })).toBe('2 notes, 1 quick, 1 survey');
  });
  it('uses the singular note', () => {
    expect(feedbackSplit({ notes: 1, quickAnswers: 0, surveys: 0 })).toBe('1 note');
  });
  it('returns an empty string when all are zero', () => {
    expect(feedbackSplit({ notes: 0, quickAnswers: 0, surveys: 0 })).toBe('');
  });
});

describe('windowEndDay', () => {
  it('is the last Pacific day counted', () => {
    expect(windowEndDay('2027-01-30T08:00:00.000Z')).toBe('January 29');
  });
  it('works for the default BETA_ENDS_AT', () => {
    const cfg = loadServerConfig({ STRIPE_SECRET_KEY: 'sk_test_x', NODE_ENV: 'development' });
    expect(windowEndDay(cfg.betaEndsAt.toISOString())).toBe('January 29');
  });
});

import { describe, it, expect } from 'vitest';
import { isNumericId, isValidEmail, textField, escapeLike, numberField, isRealDate } from './validation';

describe('isNumericId', () => {
  it('accepts a plain digit string', () => {
    expect(isNumericId('123')).toBe(true);
  });

  it('accepts a single digit', () => {
    expect(isNumericId('7')).toBe(true);
  });

  it('accepts a two-digit id', () => {
    expect(isNumericId('12')).toBe(true);
  });

  it('rejects zero', () => {
    expect(isNumericId('0')).toBe(false);
  });

  it('rejects leading zeros', () => {
    expect(isNumericId('012')).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isNumericId('')).toBe(false);
  });

  it('rejects a negative number string', () => {
    expect(isNumericId('-1')).toBe(false);
  });

  it('rejects a decimal', () => {
    expect(isNumericId('1.5')).toBe(false);
  });

  it('rejects exponent notation', () => {
    expect(isNumericId('1e5')).toBe(false);
  });

  it('rejects a string with trailing non-digit characters', () => {
    expect(isNumericId('123abc')).toBe(false);
  });

  it('rejects a string with leading whitespace', () => {
    expect(isNumericId(' 123')).toBe(false);
  });

  it('accepts the int4 maximum and rejects anything larger or longer', () => {
    expect(isNumericId('2147483647')).toBe(true);
    expect(isNumericId('2147483648')).toBe(false);
    expect(isNumericId('9999999999')).toBe(false);
    expect(isNumericId('99999999999')).toBe(false);
    expect(isNumericId('1'.repeat(400))).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(isNumericId(123)).toBe(false);
    expect(isNumericId(null)).toBe(false);
    expect(isNumericId(undefined)).toBe(false);
    expect(isNumericId(['123'])).toBe(false);
  });
});

describe('isValidEmail', () => {
  it.each(['a@b.co', 'first.last+tag@example.com', 'x@sub.domain.org'])('accepts %s', (v) => {
    expect(isValidEmail(v)).toBe(true);
  });

  it.each([
    '',
    'plain',
    'a@b',
    'a@.com',
    'a@b.',
    'a@b..com',
    'a b@c.com',
    '@b.com',
    'a@@b.com',
    `${'a'.repeat(65)}@b.com`,
  ])('rejects %j', (v) => {
    expect(isValidEmail(v)).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(isValidEmail(undefined)).toBe(false);
    expect(isValidEmail(42)).toBe(false);
    expect(isValidEmail({})).toBe(false);
  });

  it('enforces the 254-character limit', () => {
    const local = 'a'.repeat(64);
    const domainFor = (total: number) => `${'b'.repeat(total - local.length - 1 - 4)}.com`;
    expect(isValidEmail(`${local}@${domainFor(254)}`)).toBe(true);
    expect(isValidEmail(`${local}@${domainFor(255)}`)).toBe(false);
  });

  it('rejects a 100KB adversarial input quickly', () => {
    const evil = `${'a@'.repeat(50_000)}`;
    const start = performance.now();
    expect(isValidEmail(evil)).toBe(false);
    expect(performance.now() - start).toBeLessThan(50);
  });

  it('rejects a long input that passes the length guard quickly', () => {
    const evil = `a@${'b.'.repeat(120)}`;
    const start = performance.now();
    expect(isValidEmail(evil)).toBe(false);
    expect(performance.now() - start).toBeLessThan(50);
  });
});

describe('textField', () => {
  it('trims and returns the value', () => {
    expect(textField('  hi  ', { field: 'notes', max: 10 })).toEqual({ ok: true, value: 'hi' });
  });
  it('treats undefined, null and blank as absent when optional', () => {
    for (const v of [undefined, null, '   ']) {
      expect(textField(v, { field: 'notes', max: 10 })).toEqual({ ok: true, value: null });
    }
  });
  it('requires a value when required', () => {
    expect(textField('  ', { field: 'name', max: 10, required: true })).toEqual({ ok: false, error: 'name is required' });
  });
  it('rejects non-strings', () => {
    expect(textField(5, { field: 'notes', max: 10 })).toEqual({ ok: false, error: 'notes must be a string' });
  });
  it('allows exactly max characters after trimming and rejects one more', () => {
    expect(textField('a'.repeat(10), { field: 'notes', max: 10 })).toEqual({ ok: true, value: 'a'.repeat(10) });
    expect(textField('a'.repeat(11), { field: 'notes', max: 10 })).toEqual({ ok: false, error: 'notes must be 10 characters or fewer' });
  });
});

describe('escapeLike', () => {
  it('escapes backslash, percent and underscore', () => {
    expect(escapeLike('50%_off\\')).toBe('50\\%\\_off\\\\');
  });
  it('leaves other text alone', () => {
    expect(escapeLike('tomato')).toBe('tomato');
  });
});

describe('numberField', () => {
  const opts = { field: 'ph', min: 0, max: 14 };
  it('treats undefined, null and blank string as absent', () => {
    for (const v of [undefined, null, '']) {
      expect(numberField(v, opts)).toEqual({ ok: true, value: null });
    }
  });
  it('accepts numbers and numeric strings within range, inclusive', () => {
    expect(numberField(0, opts)).toEqual({ ok: true, value: 0 });
    expect(numberField(14, opts)).toEqual({ ok: true, value: 14 });
    expect(numberField('6.5', opts)).toEqual({ ok: true, value: 6.5 });
  });
  it('rejects out-of-range values with the exact message', () => {
    const err = { ok: false, error: 'ph must be a number between 0 and 14' };
    expect(numberField(14.1, opts)).toEqual(err);
    expect(numberField(-1, opts)).toEqual(err);
  });
  it('rejects non-numeric, non-finite and non-scalar input', () => {
    const err = { ok: false, error: 'ph must be a number between 0 and 14' };
    for (const v of ['abc', NaN, Infinity, true, [], {}, ' ']) {
      expect(numberField(v, opts)).toEqual(err);
    }
  });
  it('integer: accepts whole numbers and rejects fractions with the whole-number message', () => {
    const intOpts = { field: 'nitrogen', min: 0, max: 10000, integer: true };
    const err = { ok: false, error: 'nitrogen must be a whole number between 0 and 10000' };
    expect(numberField(12, intOpts)).toEqual({ ok: true, value: 12 });
    expect(numberField('40', intOpts)).toEqual({ ok: true, value: 40 });
    expect(numberField(null, intOpts)).toEqual({ ok: true, value: null });
    expect(numberField(12.5, intOpts)).toEqual(err);
    expect(numberField('0.1', intOpts)).toEqual(err);
    expect(numberField(10001, intOpts)).toEqual(err);
    expect(numberField('abc', intOpts)).toEqual(err);
  });
});

describe('isRealDate', () => {
  it('accepts real calendar dates', () => {
    expect(isRealDate('2026-02-28')).toBe(true);
    expect(isRealDate('2028-02-29')).toBe(true);
  });
  it('rejects impossible or malformed dates', () => {
    for (const v of ['2026-02-30', '2026-13-01', '2026-00-10', '2027-02-29', '2026/01/01', '', 5, null]) {
      expect(isRealDate(v)).toBe(false);
    }
  });
});

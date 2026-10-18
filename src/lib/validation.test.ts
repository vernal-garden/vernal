import { describe, it, expect } from 'vitest';
import { isNumericId, isValidEmail } from './validation';

describe('isNumericId', () => {
  it('accepts a plain digit string', () => {
    expect(isNumericId('123')).toBe(true);
  });

  it('accepts a single digit', () => {
    expect(isNumericId('0')).toBe(true);
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

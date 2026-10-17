import { describe, it, expect } from 'vitest';
import { safeReturnTo } from './returnTo';

describe('safeReturnTo', () => {
  it.each([
    ['/', '/'],
    ['/garden', '/garden'],
    ['/garden/12?season=2026', '/garden/12?season=2026'],
    // Percent-encoded input stays a literal path segment (never decoded into a host).
    ['/%2F%2Fevil.com', '/%2F%2Fevil.com'],
    ['/%5Cevil.com', '/%5Cevil.com'],
  ])('keeps internal path %s', (input, expected) => {
    expect(safeReturnTo(input)).toBe(expected);
  });

  it.each([
    ['@evil.com'],
    ['//evil.com'],
    ['/\\evil.com'],
    ['.evil.com'],
    ['https://evil.com'],
    ['/a@b'],
    ['/x\ny'],
    ['/' + 'a'.repeat(600)],
    [''],
  ])('rejects %j', (input) => {
    expect(safeReturnTo(input)).toBe('/');
  });

  it('rejects non-strings', () => {
    expect(safeReturnTo(undefined)).toBe('/');
    expect(safeReturnTo(['/garden'])).toBe('/');
    expect(safeReturnTo({ a: 1 })).toBe('/');
  });
});

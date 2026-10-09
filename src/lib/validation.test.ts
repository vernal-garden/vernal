import { describe, it, expect } from 'vitest';
import { isNumericId } from './validation';

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

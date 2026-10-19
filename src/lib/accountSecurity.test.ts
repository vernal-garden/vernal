import { describe, it, expect } from 'vitest';
import { maskEmail } from './accountSecurity';

describe('maskEmail', () => {
  it('keeps the first character and the domain', () => {
    expect(maskEmail('jane@example.com')).toBe('j•••@example.com');
  });

  it('handles a one-character local part', () => {
    expect(maskEmail('j@example.com')).toBe('j•••@example.com');
  });

  it('fully masks a string with no usable @', () => {
    expect(maskEmail('@example.com')).toBe('•••');
    expect(maskEmail('nope')).toBe('•••');
  });
});

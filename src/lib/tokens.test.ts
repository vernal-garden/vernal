import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { generateRawToken, hashToken } from './tokens';

describe('tokens', () => {
  it('generateRawToken returns 64 lowercase hex chars and differs each call', () => {
    const a = generateRawToken();
    const b = generateRawToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });

  it('hashToken is the SHA-256 hex digest', () => {
    const expected = crypto.createHash('sha256').update('abc').digest('hex');
    expect(hashToken('abc')).toBe(expected);
  });
});

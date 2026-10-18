import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { verifySignedToken } from './sessions';

function sign(token: string): string {
  const sig = crypto.createHmac('sha256', process.env.SESSION_SECRET!).update(token).digest('hex');
  return `${token}.${sig}`;
}

describe('verifySignedToken', () => {
  it('returns null for a non-string cookie value', () => {
    expect(verifySignedToken(1)).toBeNull();
    expect(verifySignedToken({ a: 1 })).toBeNull();
  });

  it('returns the token for a correctly signed value', () => {
    expect(verifySignedToken(sign('abc123'))).toBe('abc123');
  });

  it('returns null for a short signature instead of throwing', () => {
    expect(() => verifySignedToken('abc123.short')).not.toThrow();
    expect(verifySignedToken('abc123.short')).toBeNull();
  });

  it('returns null for a long signature', () => {
    expect(verifySignedToken(`abc123.${'f'.repeat(200)}`)).toBeNull();
  });

  it('returns null for a wrong signature of the right length', () => {
    expect(verifySignedToken(`abc123.${'0'.repeat(64)}`)).toBeNull();
  });

  it('returns null for a multi-byte signature of the right character length', () => {
    const bad = `abc123.é${'a'.repeat(63)}`;
    expect(() => verifySignedToken(bad)).not.toThrow();
    expect(verifySignedToken(bad)).toBeNull();
  });

  it('returns null for a malformed value', () => {
    expect(verifySignedToken('no-dot')).toBeNull();
    expect(verifySignedToken('a.b.c')).toBeNull();
  });
});

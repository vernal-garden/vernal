import crypto from 'crypto';

// Raw tokens are emailed to users; only hashToken(raw) is stored. SHA-256 is
// enough here (unlike passwords): the raw value has 256 bits of entropy, and a
// fast hash lets lookups use the UNIQUE index instead of scanning rows.
export function generateRawToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function hashToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

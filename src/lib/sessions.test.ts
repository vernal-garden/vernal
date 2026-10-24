import { describe, it, expect, afterAll } from 'vitest';
import crypto from 'crypto';
import { Pool } from 'pg';
import { verifySignedToken, rotateLiveSessionToken, claimSession, createGuestSession, findSession } from './sessions';
import { hashToken } from './tokens';

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

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
afterAll(() => pool.end());

// Migrations 024 and 025: the hashing trigger and the plaintext column are gone.
describe('guest_sessions plaintext token retired', () => {
  it('no longer has a token column', async () => {
    const { rows } = await pool.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name = 'guest_sessions' AND column_name = 'token'",
    );
    expect(rows).toHaveLength(0);
  });

  it('no longer has the token_hash trigger or its function', async () => {
    const trigger = await pool.query("SELECT 1 FROM pg_trigger WHERE tgname = 'guest_sessions_fill_token_hash'");
    const fn = await pool.query("SELECT 1 FROM pg_proc WHERE proname = 'guest_sessions_fill_token_hash'");
    expect(trigger.rows).toHaveLength(0);
    expect(fn.rows).toHaveLength(0);
  });
});

describe('rotateLiveSessionToken', () => {
  async function insertAccount(): Promise<number> {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO accounts (email, zone, zone_location_label) VALUES ($1, '7b', 'Test City') RETURNING id`,
      [`live-rotate-${crypto.randomBytes(6).toString('hex')}@example.com`],
    );
    return Number(rows[0].id);
  }

  async function insertSession(expiry: string): Promise<{ id: string; hash: string }> {
    const hash = hashToken('live-rotate-' + crypto.randomBytes(8).toString('hex'));
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO guest_sessions (token_hash, expires_at) VALUES ($1, now() + $2::interval) RETURNING id`,
      [hash, expiry],
    );
    return { id: rows[0].id, hash };
  }

  it('returns null for an expired row and leaves it unchanged', async () => {
    const { id, hash } = await insertSession('-1 hour');
    expect(await rotateLiveSessionToken(pool, hash, await insertAccount())).toBeNull();
    const { rows } = await pool.query<{ token_hash: string; expired: boolean; account_id: number | null }>(
      'SELECT token_hash, expires_at <= now() AS expired, account_id FROM guest_sessions WHERE id = $1',
      [id],
    );
    expect(rows[0]).toEqual({ token_hash: hash, expired: true, account_id: null });
  });

  it('rotates a live row to a new token', async () => {
    const { id, hash } = await insertSession('1 hour');
    const rotated = await rotateLiveSessionToken(pool, hash, await insertAccount());
    expect(rotated).not.toBeNull();
    const raw = verifySignedToken(rotated!.signedToken)!;
    const { rows } = await pool.query<{ token_hash: string }>('SELECT token_hash FROM guest_sessions WHERE id = $1', [id]);
    expect(rows[0].token_hash).toBe(hashToken(raw));
    expect(rows[0].token_hash).not.toBe(hash);
  });
});

describe('authenticated_at', () => {
  async function insertAccount(): Promise<number> {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO accounts (email, zone, zone_location_label) VALUES ($1, '7b', 'Test City') RETURNING id`,
      [`auth-at-${crypto.randomBytes(6).toString('hex')}@example.com`],
    );
    return Number(rows[0].id);
  }

  async function authenticatedAtFor(signedToken: string): Promise<Date | null> {
    const { rows } = await pool.query<{ authenticated_at: Date | null }>(
      'SELECT authenticated_at FROM guest_sessions WHERE token_hash = $1',
      [hashToken(verifySignedToken(signedToken)!)],
    );
    return rows[0].authenticated_at;
  }

  function expectRecent(at: Date | null) {
    expect(at).not.toBeNull();
    expect(Math.abs(Date.now() - at!.getTime())).toBeLessThan(5000);
  }

  it('claimSession with no existing token creates a row with authenticated_at set', async () => {
    const { signedToken } = await claimSession(await insertAccount(), null);
    expectRecent(await authenticatedAtFor(signedToken));
  });

  it('claimSession on an existing guest row sets authenticated_at', async () => {
    const guest = await createGuestSession();
    expect(await authenticatedAtFor(guest.signedToken)).toBeNull();
    const guestHash = hashToken(verifySignedToken(guest.signedToken)!);
    const { signedToken } = await claimSession(await insertAccount(), guestHash);
    expectRecent(await authenticatedAtFor(signedToken));
  });

  it('rotateLiveSessionToken moves an old authenticated_at to now', async () => {
    const hash = hashToken('auth-at-rotate-' + crypto.randomBytes(8).toString('hex'));
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO guest_sessions (token_hash, expires_at, authenticated_at)
       VALUES ($1, now() + interval '1 hour', now() - interval '1 hour') RETURNING id`,
      [hash],
    );
    const rotated = await rotateLiveSessionToken(pool, hash, await insertAccount());
    expect(rotated).not.toBeNull();
    const after = await pool.query<{ authenticated_at: Date }>(
      'SELECT authenticated_at FROM guest_sessions WHERE id = $1',
      [rows[0].id],
    );
    expectRecent(after.rows[0].authenticated_at);
  });

  it('createGuestSession leaves authenticated_at NULL', async () => {
    const { signedToken } = await createGuestSession();
    expect(await authenticatedAtFor(signedToken)).toBeNull();
  });

  it('findSession returns authenticatedAt as a Date for an account session and null for a guest', async () => {
    const account = await claimSession(await insertAccount(), null);
    const found = await findSession(account.signedToken);
    expect(found!.authenticatedAt).toBeInstanceOf(Date);

    const guest = await createGuestSession();
    expect((await findSession(guest.signedToken))!.authenticatedAt).toBeNull();
  });
});

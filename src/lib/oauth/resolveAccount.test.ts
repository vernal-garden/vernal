import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { Pool } from 'pg';
import type { Profile } from 'passport-google-oauth20';
import type { OAuthUser } from './providers/google';
import { resolveOAuthAccount, OAuthUnverifiedEmailError, OAuthLinkRequiresPasswordError } from './resolveAccount';
import { db } from '../db';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL must be set to run tests');
const pool = new Pool({ connectionString: url });

async function resetDb() {
  await pool.query('TRUNCATE accounts, guest_sessions, password_reset_tokens RESTART IDENTITY CASCADE');
}

function googleUser(id: string, email: string, verified: boolean | undefined = true, hd?: string): OAuthUser {
  return {
    provider: 'google',
    accessToken: 'access',
    refreshToken: undefined,
    profile: {
      id,
      provider: 'google',
      displayName: 'Gardener',
      emails: [{ value: email, verified }],
      photos: [],
      _json: hd ? { hd } : {},
    } as unknown as Profile,
  };
}

async function passwordAccount(email: string, verified: boolean): Promise<number> {
  const hash = await bcrypt.hash('Password123!', 4);
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO accounts (email, password_hash, zone, zone_location_label, email_verified)
     VALUES ($1, $2, '7b', 'Test City', $3) RETURNING id`,
    [email, hash, verified],
  );
  return rows[0].id;
}

beforeEach(resetDb);
afterAll(async () => {
  await pool.end();
  await db.end();
});

describe('resolveOAuthAccount', () => {
  it('links Google to a verified password account and keeps the password', async () => {
    const id = await passwordAccount('linked@example.com', true);
    const result = await resolveOAuthAccount(googleUser('g-1', 'Linked@Example.com', true, 'example.com'));
    expect(result).toEqual({ accountId: id, isNew: false });
    const { rows } = await pool.query('SELECT password_hash FROM accounts WHERE id = $1', [id]);
    expect(rows[0].password_hash).not.toBeNull();
  });

  it('claims an unverified password account: password removed, tokens and sessions cleared', async () => {
    const id = await passwordAccount('squatted@example.com', false);
    await pool.query(
      `INSERT INTO guest_sessions (token, expires_at, account_id, migrated_at)
       VALUES ('squatter-session', now() + interval '1 day', $1, now())`,
      [id],
    );
    await pool.query(
      `INSERT INTO password_reset_tokens (account_id, token_hash, expires_at)
       VALUES ($1, 'h1', now() + interval '1 hour')`,
      [id],
    );

    const result = await resolveOAuthAccount(googleUser('g-2', 'squatted@example.com', true, 'example.com'));
    expect(result).toEqual({ accountId: id, isNew: false });

    const { rows } = await pool.query<{ password_hash: string | null; email_verified: boolean }>(
      'SELECT password_hash, email_verified FROM accounts WHERE id = $1',
      [id],
    );
    expect(rows[0].password_hash).toBeNull();
    expect(rows[0].email_verified).toBe(true);
    expect((await pool.query('SELECT 1 FROM guest_sessions WHERE account_id = $1 AND expires_at > now()', [id])).rows).toHaveLength(0);
    expect((await pool.query('SELECT 1 FROM password_reset_tokens WHERE account_id = $1', [id])).rows).toHaveLength(0);
    expect((await pool.query('SELECT 1 FROM oauth_identities WHERE account_id = $1', [id])).rows).toHaveLength(1);
  });

  it('refuses a Google email Google has not verified', async () => {
    await passwordAccount('unverified-google@example.com', true);
    await expect(
      resolveOAuthAccount(googleUser('g-3', 'unverified-google@example.com', false)),
    ).rejects.toBeInstanceOf(OAuthUnverifiedEmailError);
    expect((await pool.query('SELECT 1 FROM oauth_identities')).rows).toHaveLength(0);
  });

  it('creates a new verified account with a lowercased email', async () => {
    const result = await resolveOAuthAccount(googleUser('g-4', 'New.Person@Example.com'));
    expect(result.isNew).toBe(true);
    const { rows } = await pool.query<{ email: string; email_verified: boolean }>(
      'SELECT email, email_verified FROM accounts WHERE id = $1',
      [result.accountId],
    );
    expect(rows[0]).toEqual({ email: 'new.person@example.com', email_verified: true });
  });

  it('returns the existing account for a known Google identity', async () => {
    const first = await resolveOAuthAccount(googleUser('g-5', 'repeat@example.com'));
    const second = await resolveOAuthAccount(googleUser('g-5', 'repeat@example.com'));
    expect(second).toEqual({ accountId: first.accountId, isNew: false });
  });
});

describe('resolveOAuthAccount — which addresses Google can vouch for', () => {
  it('links a gmail.com address to an existing account', async () => {
    const id = await passwordAccount('grower@gmail.com', true);
    expect(await resolveOAuthAccount(googleUser('g-10', 'grower@gmail.com'))).toEqual({ accountId: id, isNew: false });
  });

  it('links a googlemail.com address to an existing account', async () => {
    const id = await passwordAccount('grower@googlemail.com', true);
    expect(await resolveOAuthAccount(googleUser('g-11', 'grower@googlemail.com'))).toEqual({ accountId: id, isNew: false });
  });

  it('links a Workspace address whose hd matches the domain, case-insensitively', async () => {
    const id = await passwordAccount('ann@farm.example', true);
    expect(await resolveOAuthAccount(googleUser('g-12', 'ann@farm.example', true, 'Farm.Example'))).toEqual({ accountId: id, isNew: false });
  });

  it('refuses a verified account when hd is a different domain, writing nothing', async () => {
    await passwordAccount('bob@farm.example', true);
    await expect(resolveOAuthAccount(googleUser('g-13', 'bob@farm.example', true, 'other.example'))).rejects.toBeInstanceOf(OAuthLinkRequiresPasswordError);
    expect((await pool.query('SELECT 1 FROM oauth_identities')).rows).toHaveLength(0);
  });

  it('refuses to claim an unverified account for a non-Google address, leaving it untouched', async () => {
    const id = await passwordAccount('cara@yahoo.example', false);
    await expect(resolveOAuthAccount(googleUser('g-14', 'cara@yahoo.example'))).rejects.toBeInstanceOf(OAuthLinkRequiresPasswordError);
    const { rows } = await pool.query<{ password_hash: string | null; email_verified: boolean }>(
      'SELECT password_hash, email_verified FROM accounts WHERE id = $1',
      [id],
    );
    expect(rows[0].password_hash).not.toBeNull();
    expect(rows[0].email_verified).toBe(false);
    expect((await pool.query('SELECT 1 FROM oauth_identities')).rows).toHaveLength(0);
  });

  it('still creates a new account for a non-Google address with no match', async () => {
    const result = await resolveOAuthAccount(googleUser('g-15', 'dee@yahoo.example'));
    expect(result.isNew).toBe(true);
  });

  it('a known identity signs in even with a non-Google address', async () => {
    const first = await resolveOAuthAccount(googleUser('g-16', 'eve@yahoo.example'));
    expect(await resolveOAuthAccount(googleUser('g-16', 'eve@yahoo.example'))).toEqual({ accountId: first.accountId, isNew: false });
  });
});

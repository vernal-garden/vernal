import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { Pool } from 'pg';
import app from '../index';
import * as mailer from '../lib/mailer';
import { hashToken } from '../lib/tokens';

vi.mock('../lib/mailer', () => ({ sendMail: vi.fn().mockResolvedValue(undefined) }));
const sendMailMock = vi.mocked(mailer.sendMail);

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL must be set to run tests');
const pool = new Pool({ connectionString: url });

async function createUser(email: string): Promise<number> {
  const hash = await bcrypt.hash('Password123!', 4);
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO accounts (email, password_hash, zone, zone_location_label, email_verified)
     VALUES ($1, $2, '7b', 'Test City', true) RETURNING id`,
    [email, hash],
  );
  return rows[0].id;
}

// An account whose email was changed from oldEmail to newEmail, plus the raw
// revert token mailed to oldEmail.
async function changedAccount(oldEmail: string, newEmail: string, expiresIn = '7 days') {
  const id = await createUser(newEmail);
  const raw = crypto.randomBytes(32).toString('hex');
  await pool.query(
    `INSERT INTO email_revert_tokens (account_id, token_hash, old_email, new_email, expires_at)
     VALUES ($1, $2, $3, $4, NOW() + $5::interval)`,
    [id, hashToken(raw), oldEmail, newEmail, expiresIn],
  );
  return { id, raw };
}

async function loginAgent(email: string) {
  const agent = request.agent(app);
  await agent.post('/api/auth/guest');
  await agent.post('/api/auth/login').send({ email, password: 'Password123!' });
  return agent;
}

const revert = (token: unknown) => request(app).post('/api/auth/email/revert').send({ token });

beforeAll(async () => {
  await pool.query('TRUNCATE accounts, guest_sessions, password_reset_tokens RESTART IDENTITY CASCADE');
});
beforeEach(() => sendMailMock.mockClear());
afterAll(() => pool.end());

describe('POST /api/auth/email/revert', () => {
  it('restores the old email, scrambles the password, signs out every device and mails a reset link', async () => {
    const { id, raw } = await changedAccount('owner@example.com', 'thief@example.com');
    const thief = await loginAgent('thief@example.com');
    expect((await thief.get('/api/me')).status).toBe(200);

    const res = await revert(raw); // no session cookie: the link works logged out
    expect(res.status).toBe(200);
    expect(res.body.data.email).toBe('owner@example.com');

    const { rows } = await pool.query(
      'SELECT email, email_verified, pending_email FROM accounts WHERE id = $1',
      [id],
    );
    expect(rows[0]).toEqual({ email: 'owner@example.com', email_verified: true, pending_email: null });

    expect((await thief.get('/api/me')).status).toBe(401);
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'owner@example.com', password: 'Password123!' });
    expect(login.status).not.toBe(200);

    const mail = sendMailMock.mock.calls.find(([o]) => o.to === 'owner@example.com')![0];
    const resetToken = mail.text.match(/reset-password\?token=([a-f0-9]+)/)![1];
    const reset = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: resetToken, password: 'BrandNew123!' });
    expect(reset.status).toBe(200);
  });

  it('marks other revert and email-change tokens used and clears a pending change', async () => {
    const { id, raw } = await changedAccount('owner2@example.com', 'thief2@example.com');
    await pool.query(
      `INSERT INTO email_revert_tokens (account_id, token_hash, old_email, new_email, expires_at)
       VALUES ($1, 'other-revert', 'x@example.com', 'thief2@example.com', NOW() + INTERVAL '7 days')`,
      [id],
    );
    await pool.query(
      `INSERT INTO email_change_tokens (account_id, token_hash, new_email, expires_at)
       VALUES ($1, 'pending-change', 'next@example.com', NOW() + INTERVAL '1 day')`,
      [id],
    );
    await pool.query("UPDATE accounts SET pending_email = 'next@example.com' WHERE id = $1", [id]);

    expect((await revert(raw)).status).toBe(200);

    const unusedRevert = await pool.query(
      'SELECT 1 FROM email_revert_tokens WHERE account_id = $1 AND used_at IS NULL',
      [id],
    );
    const unusedChange = await pool.query(
      'SELECT 1 FROM email_change_tokens WHERE account_id = $1 AND used_at IS NULL',
      [id],
    );
    expect(unusedRevert.rowCount).toBe(0);
    expect(unusedChange.rowCount).toBe(0);
    const { rows } = await pool.query('SELECT pending_email FROM accounts WHERE id = $1', [id]);
    expect(rows[0].pending_email).toBeNull();
  });

  it('removes Google links made while the email was changed', async () => {
    const { id, raw } = await changedAccount('owner6@example.com', 'thief6@gmail.com');
    await pool.query(
      `INSERT INTO oauth_identities (account_id, provider, provider_user_id, provider_email)
       VALUES ($1, 'google', 'g-attacker', 'thief6@gmail.com')`,
      [id],
    );

    expect((await revert(raw)).status).toBe(200);

    const links = await pool.query('SELECT 1 FROM oauth_identities WHERE account_id = $1', [id]);
    expect(links.rowCount).toBe(0);
  });

  it('keeps an older revert link valid after a newer one is used', async () => {
    const { id, raw: olderRaw } = await changedAccount('owner7@example.com', 'mid7@example.com');
    const newerRaw = crypto.randomBytes(32).toString('hex');
    await pool.query(
      `INSERT INTO email_revert_tokens (account_id, token_hash, old_email, new_email, expires_at)
       VALUES ($1, $2, 'mid7@example.com', 'thief7@example.com', NOW() + INTERVAL '7 days')`,
      [id, hashToken(newerRaw)],
    );

    const newer = await revert(newerRaw);
    expect(newer.status).toBe(200);
    expect(newer.body.data.email).toBe('mid7@example.com');

    const older = await revert(olderRaw);
    expect(older.status).toBe(200);
    expect(older.body.data.email).toBe('owner7@example.com');
    const { rows } = await pool.query('SELECT email FROM accounts WHERE id = $1', [id]);
    expect(rows[0].email).toBe('owner7@example.com');
  });

  it('marks newer revert links used when an older one is used', async () => {
    const { id, raw: olderRaw } = await changedAccount('owner8@example.com', 'mid8@example.com');
    const newerRaw = crypto.randomBytes(32).toString('hex');
    await pool.query(
      `INSERT INTO email_revert_tokens (account_id, token_hash, old_email, new_email, expires_at)
       VALUES ($1, $2, 'mid8@example.com', 'thief8@example.com', NOW() + INTERVAL '7 days')`,
      [id, hashToken(newerRaw)],
    );

    expect((await revert(olderRaw)).status).toBe(200);
    expect((await revert(newerRaw)).status).toBe(400);
  });

  it('rejects a reused token with 400', async () => {
    const { raw } = await changedAccount('owner3@example.com', 'thief3@example.com');
    expect((await revert(raw)).status).toBe(200);
    const again = await revert(raw);
    expect(again.status).toBe(400);
    expect(again.body.error).toBe('This link is invalid or has expired.');
  });

  it('rejects an expired token with 400', async () => {
    const { raw } = await changedAccount('owner4@example.com', 'thief4@example.com', '-1 hour');
    expect((await revert(raw)).status).toBe(400);
  });

  it('rejects a missing or unknown token with 400', async () => {
    expect((await revert(undefined)).status).toBe(400);
    expect((await revert('f'.repeat(64))).status).toBe(400);
  });

  it('returns 409 and changes nothing when the old address now belongs to another account', async () => {
    const { id, raw } = await changedAccount('owner5@example.com', 'thief5@example.com');
    await createUser('owner5@example.com');

    const res = await revert(raw);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/another account/i);

    const { rows } = await pool.query('SELECT email FROM accounts WHERE id = $1', [id]);
    expect(rows[0].email).toBe('thief5@example.com');
    const token = await pool.query('SELECT used_at FROM email_revert_tokens WHERE token_hash = $1', [hashToken(raw)]);
    expect(token.rows[0].used_at).toBeNull();
  });
});

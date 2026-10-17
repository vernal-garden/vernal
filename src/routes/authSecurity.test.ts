import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { Pool } from 'pg';
import app from '../index';
import * as mailer from '../lib/mailer';
import { hashToken } from '../lib/tokens';

vi.mock('../lib/mailer', () => ({ sendMail: vi.fn().mockResolvedValue(undefined) }));
const sendMailMock = vi.mocked(mailer.sendMail);

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL must be set to run tests');
const pool = new Pool({ connectionString: url });

async function resetDb() {
  await pool.query('TRUNCATE accounts, guest_sessions, password_reset_tokens RESTART IDENTITY CASCADE');
}

let emailCounter = 0;
function nextEmail(prefix: string): string {
  emailCounter += 1;
  return `${prefix}-${emailCounter}@example.com`;
}

async function createUser(email: string, password = 'Password123!', verified = false): Promise<number> {
  const hash = await bcrypt.hash(password, 4);
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO accounts (email, password_hash, zone, zone_location_label, email_verified)
     VALUES ($1, $2, '7b', 'Test City', $3) RETURNING id`,
    [email, hash, verified],
  );
  return rows[0].id;
}

function cookiesOf(res: request.Response): string[] {
  return res.headers['set-cookie'] as unknown as string[];
}

// The raw (unsigned) session token inside a Set-Cookie header.
function rawTokenOf(cookies: string[]): string {
  const sid = cookies.find((c) => c.startsWith('_vernal_sid='))!;
  const value = decodeURIComponent(sid.split(';')[0].slice('_vernal_sid='.length));
  return value.split('.')[0];
}

async function mailTokenTo(address: string): Promise<string> {
  await vi.waitFor(() => {
    expect(sendMailMock.mock.calls.some(([opts]) => opts.to === address)).toBe(true);
  });
  const call = [...sendMailMock.mock.calls].reverse().find(([opts]) => opts.to === address)!;
  const match = call[0].text.match(/token=([a-f0-9]+)/);
  if (!match) throw new Error('No token in email');
  return match[1];
}

beforeAll(resetDb);
beforeEach(() => sendMailMock.mockClear());
afterAll(() => pool.end());

describe('session rotation on login', () => {
  it('login issues a new token; the pre-login cookie stops working', async () => {
    const email = nextEmail('rotate');
    await createUser(email);
    const guest = await request(app).post('/api/auth/guest');
    const guestCookie = cookiesOf(guest);

    const login = await request(app)
      .post('/api/auth/login')
      .set('Cookie', guestCookie)
      .send({ email, password: 'Password123!' });
    expect(login.status).toBe(200);
    const newCookie = cookiesOf(login);
    expect(rawTokenOf(newCookie)).not.toBe(rawTokenOf(guestCookie));

    expect((await request(app).get('/api/me').set('Cookie', guestCookie)).status).toBe(401);
    expect((await request(app).get('/api/me').set('Cookie', newCookie)).status).toBe(200);
  });

  it('register rotates the token and still migrates guest gardens', async () => {
    const guest = await request(app).post('/api/auth/guest');
    const guestCookie = cookiesOf(guest);
    const { rows: sess } = await pool.query<{ id: string }>(
      'SELECT id FROM guest_sessions WHERE token = $1',
      [rawTokenOf(guestCookie)],
    );
    const { rows: garden } = await pool.query<{ id: number }>(
      `INSERT INTO gardens (guest_session_id, name, style, zone)
       VALUES ($1, 'Guest plot', 'grid', '7b') RETURNING id`,
      [sess[0].id],
    );

    const email = nextEmail('register-rotate');
    const reg = await request(app)
      .post('/api/auth/register')
      .set('Cookie', guestCookie)
      .send({ email, password: 'Password123!' });
    expect(reg.status).toBe(201);

    const { rows: owned } = await pool.query<{ owner_id: number }>(
      'SELECT owner_id FROM gardens WHERE id = $1',
      [garden[0].id],
    );
    expect(owned[0].owner_id).toBe(reg.body.data.account.id);
    expect((await request(app).get('/api/me').set('Cookie', guestCookie)).status).toBe(401);
    const newCookie = cookiesOf(reg);
    expect(rawTokenOf(newCookie)).not.toBe(rawTokenOf(guestCookie));
    expect((await request(app).get('/api/me').set('Cookie', newCookie)).status).toBe(200);
  });

  it('register through an expired guest cookie rotates it and migrates the garden', async () => {
    const guest = await request(app).post('/api/auth/guest');
    const guestCookie = cookiesOf(guest);
    const { rows: sess } = await pool.query<{ id: string }>(
      `UPDATE guest_sessions SET expires_at = now() - interval '1 day'
       WHERE token = $1 RETURNING id`,
      [rawTokenOf(guestCookie)],
    );
    const { rows: garden } = await pool.query<{ id: number }>(
      `INSERT INTO gardens (guest_session_id, name, style, zone)
       VALUES ($1, 'Expired plot', 'grid', '7b') RETURNING id`,
      [sess[0].id],
    );

    const reg = await request(app)
      .post('/api/auth/register')
      .set('Cookie', guestCookie)
      .send({ email: nextEmail('register-expired'), password: 'Password123!' });
    expect(reg.status).toBe(201);

    const { rows: owned } = await pool.query<{ owner_id: number }>(
      'SELECT owner_id FROM gardens WHERE id = $1',
      [garden[0].id],
    );
    expect(owned[0].owner_id).toBe(reg.body.data.account.id);
    expect((await request(app).get('/api/me').set('Cookie', guestCookie)).status).toBe(401);
    expect((await request(app).get('/api/me').set('Cookie', cookiesOf(reg))).status).toBe(200);
  });

  it('a second account logging in on the same cookie gets its own session; the first is untouched', async () => {
    const emailA = nextEmail('takeover-a');
    const emailB = nextEmail('takeover-b');
    const idA = await createUser(emailA);
    const idB = await createUser(emailB);

    const loginA = await request(app).post('/api/auth/login').send({ email: emailA, password: 'Password123!' });
    const cookieA = cookiesOf(loginA);
    const loginB = await request(app)
      .post('/api/auth/login')
      .set('Cookie', cookieA)
      .send({ email: emailB, password: 'Password123!' });
    expect(loginB.status).toBe(200);
    const cookieB = cookiesOf(loginB);
    expect(rawTokenOf(cookieB)).not.toBe(rawTokenOf(cookieA));

    const { rows } = await pool.query<{ account_id: number }>(
      'SELECT account_id FROM guest_sessions WHERE token = $1',
      [rawTokenOf(cookieA)],
    );
    expect(Number(rows[0].account_id)).toBe(idA);
    expect((await request(app).get('/api/me').set('Cookie', cookieB)).status).toBe(200);
    expect(idB).not.toBe(idA);
  });
});

describe('DELETE /api/auth/session', () => {
  it('account logout revokes the session row', async () => {
    const email = nextEmail('logout');
    await createUser(email);
    const login = await request(app).post('/api/auth/login').send({ email, password: 'Password123!' });
    const cookie = cookiesOf(login);

    const out = await request(app).delete('/api/auth/session').set('Cookie', cookie);
    expect(out.status).toBe(200);

    const { rows } = await pool.query('SELECT 1 FROM guest_sessions WHERE token = $1', [rawTokenOf(cookie)]);
    expect(rows).toHaveLength(0);
    expect((await request(app).get('/api/me').set('Cookie', cookie)).status).toBe(401);
  });

  it('guest logout keeps the guest row (recoverable flow unchanged)', async () => {
    const guest = await request(app).post('/api/auth/guest');
    const cookie = cookiesOf(guest);
    await request(app).delete('/api/auth/session').set('Cookie', cookie);
    const { rows } = await pool.query('SELECT 1 FROM guest_sessions WHERE token = $1', [rawTokenOf(cookie)]);
    expect(rows).toHaveLength(1);
  });
});

describe('password reset', () => {
  it('stores SHA-256 hashes and a new request replaces the previous token', async () => {
    const email = nextEmail('reset-hash');
    const accountId = await createUser(email);

    await request(app).post('/api/auth/forgot-password').send({ email });
    const first = await mailTokenTo(email);
    sendMailMock.mockClear();
    await request(app).post('/api/auth/forgot-password').send({ email });
    const second = await mailTokenTo(email);

    const { rows } = await pool.query<{ token_hash: string }>(
      'SELECT token_hash FROM password_reset_tokens WHERE account_id = $1 AND used_at IS NULL',
      [accountId],
    );
    expect(rows.map((r) => r.token_hash)).toEqual([hashToken(second)]);

    const stale = await request(app).post('/api/auth/reset-password').send({ token: first, password: 'NewPassword1!' });
    expect(stale.status).toBe(400);
  });

  it('reset sets the password, verifies the email, revokes all sessions, and is single-use', async () => {
    const email = nextEmail('reset-ok');
    const accountId = await createUser(email);
    const login = await request(app).post('/api/auth/login').send({ email, password: 'Password123!' });
    const oldCookie = cookiesOf(login);

    await pool.query('UPDATE accounts SET pending_email = $1 WHERE id = $2', ['pending-target@example.com', accountId]);
    await pool.query(
      `INSERT INTO email_change_tokens (account_id, token_hash, new_email, expires_at)
       VALUES ($1, $2, 'pending-target@example.com', NOW() + INTERVAL '1 hour')`,
      [accountId, hashToken('pending-change-token')],
    );

    await request(app).post('/api/auth/forgot-password').send({ email });
    const token = await mailTokenTo(email);

    const reset = await request(app).post('/api/auth/reset-password').send({ token, password: 'NewPassword1!' });
    expect(reset.status).toBe(200);

    expect((await request(app).get('/api/me').set('Cookie', oldCookie)).status).toBe(401);

    const { rows } = await pool.query<{ email_verified: boolean; pending_email: string | null }>(
      'SELECT email_verified, pending_email FROM accounts WHERE id = $1',
      [accountId],
    );
    expect(rows[0].email_verified).toBe(true);
    expect(rows[0].pending_email).toBeNull();
    const changeTokens = await pool.query('SELECT 1 FROM email_change_tokens WHERE account_id = $1', [accountId]);
    expect(changeTokens.rowCount).toBe(0);

    const relogin = await request(app).post('/api/auth/login').send({ email, password: 'NewPassword1!' });
    expect(relogin.status).toBe(200);

    const reuse = await request(app).post('/api/auth/reset-password').send({ token, password: 'Another1!' });
    expect(reuse.status).toBe(400);
  });

  it('old cookie after reset is plain unauthenticated, not guestExpired', async () => {
    const email = nextEmail('reset-cold');
    await createUser(email);
    const login = await request(app).post('/api/auth/login').send({ email, password: 'Password123!' });
    const oldCookie = cookiesOf(login);

    await request(app).post('/api/auth/forgot-password').send({ email });
    const token = await mailTokenTo(email);
    await request(app).post('/api/auth/reset-password').send({ token, password: 'NewPassword1!' });

    const res = await request(app).get('/api/auth/session').set('Cookie', oldCookie);
    expect(res.status).toBe(200);
    expect(res.body.data.authenticated).toBe(false);
    expect(res.body.data).not.toHaveProperty('guestExpired');
  });

  it('two concurrent resets with the same token: exactly one succeeds', async () => {
    const email = nextEmail('reset-race');
    await createUser(email);
    await request(app).post('/api/auth/forgot-password').send({ email });
    const token = await mailTokenTo(email);

    const results = await Promise.all([
      request(app).post('/api/auth/reset-password').send({ token, password: 'NewPassword1!' }),
      request(app).post('/api/auth/reset-password').send({ token, password: 'NewPassword2!' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
  });

  it('rejects non-string token/password with 400', async () => {
    const res = await request(app).post('/api/auth/reset-password').send({ token: ['x'], password: 'NewPassword1!' });
    expect(res.status).toBe(400);
  });
});

describe('email verification', () => {
  it('register sends a verification link that verifies once', async () => {
    const email = nextEmail('verify');
    const reg = await request(app).post('/api/auth/register').send({ email, password: 'Password123!' });
    expect(reg.status).toBe(201);
    const token = await mailTokenTo(email);

    const ok = await request(app).post('/api/auth/verify-email').send({ token });
    expect(ok.status).toBe(200);
    expect(ok.body.data.verified).toBe(true);

    const { rows } = await pool.query<{ email_verified: boolean }>(
      'SELECT email_verified FROM accounts WHERE email = $1',
      [email],
    );
    expect(rows[0].email_verified).toBe(true);

    const again = await request(app).post('/api/auth/verify-email').send({ token });
    expect(again.status).toBe(400);
  });

  it('rejects a token whose email no longer matches the account', async () => {
    const email = nextEmail('verify-stale');
    await request(app).post('/api/auth/register').send({ email, password: 'Password123!' });
    const token = await mailTokenTo(email);
    await pool.query('UPDATE accounts SET email = $1 WHERE email = $2', [nextEmail('changed'), email]);

    const res = await request(app).post('/api/auth/verify-email').send({ token });
    expect(res.status).toBe(400);
  });

  it('a resend invalidates the previous link', async () => {
    const email = nextEmail('verify-resend');
    const agent = request.agent(app);
    await agent.post('/api/auth/register').send({ email, password: 'Password123!' });
    const token1 = await mailTokenTo(email);
    sendMailMock.mockClear();
    const resend = await agent.post('/api/me/verify-email/resend');
    expect(resend.body.data.sent).toBe(true);
    const token2 = await mailTokenTo(email);
    expect(token2).not.toBe(token1);

    expect((await request(app).post('/api/auth/verify-email').send({ token: token1 })).status).toBe(400);
    expect((await request(app).post('/api/auth/verify-email').send({ token: token2 })).status).toBe(200);
  });

  it('rejects an expired token and a missing token', async () => {
    const email = nextEmail('verify-expired');
    await request(app).post('/api/auth/register').send({ email, password: 'Password123!' });
    const token = await mailTokenTo(email);
    await pool.query(
      `UPDATE email_verification_tokens SET expires_at = now() - interval '1 minute' WHERE token_hash = $1`,
      [hashToken(token)],
    );
    expect((await request(app).post('/api/auth/verify-email').send({ token })).status).toBe(400);
    expect((await request(app).post('/api/auth/verify-email').send({})).status).toBe(400);
  });
});

describe('OAuth callback state check', () => {
  const state = (nonce: string, returnTo = '/') =>
    Buffer.from(JSON.stringify({ nonce, returnTo })).toString('base64url');

  it('rejects a callback with no state', async () => {
    const res = await request(app).get('/api/auth/oauth/google/callback?code=abc');
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/\/login\?error=oauth_csrf$/);
  });

  it('rejects a callback whose nonce does not match the cookie', async () => {
    const res = await request(app)
      .get(`/api/auth/oauth/google/callback?code=abc&state=${state('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')}`)
      .set('Cookie', ['_vernal_oauth_nonce=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']);
    expect(res.headers.location).toMatch(/\/login\?error=oauth_csrf$/);
    expect(cookiesOf(res).some((c) => c.startsWith('_vernal_oauth_nonce=;'))).toBe(true);
  });

  it('rejects a non-hex nonce without throwing', async () => {
    const res = await request(app)
      .get(`/api/auth/oauth/google/callback?code=abc&state=${state('é')}`)
      .set('Cookie', ['_vernal_oauth_nonce=a']);
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/\/login\?error=oauth_csrf$/);
  });

  it('rejects a callback with state but no nonce cookie', async () => {
    const res = await request(app).get(`/api/auth/oauth/google/callback?code=abc&state=${state('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')}`);
    expect(res.headers.location).toMatch(/\/login\?error=oauth_csrf$/);
  });

  it('passes a matching state through to passport (redirects to Google when no code)', async () => {
    const res = await request(app)
      .get(`/api/auth/oauth/google/callback?state=${state('cccccccccccccccccccccccccccccccc')}`)
      .set('Cookie', ['_vernal_oauth_nonce=cccccccccccccccccccccccccccccccc']);
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/^https:\/\/accounts\.google\.com\//);
  });

  it('initiation sanitises returnTo inside state', async () => {
    const res = await request(app).get('/api/auth/oauth/google?returnTo=@evil.com');
    const location = new URL(res.headers.location);
    const decoded = JSON.parse(Buffer.from(location.searchParams.get('state')!, 'base64url').toString('utf8'));
    expect(decoded.returnTo).toBe('/');
  });
});

describe('login credential re-check', () => {
  it('refuses a session when the password was removed while bcrypt ran', async () => {
    const email = nextEmail('race');
    const id = await createUser(email, 'Password123!', false);
    const spy = vi.spyOn(bcrypt, 'compare').mockImplementationOnce((async () => {
      // Simulates an OAuth claim committing mid-compare.
      await pool.query('UPDATE accounts SET password_hash = NULL WHERE id = $1', [id]);
      return true;
    }) as unknown as typeof bcrypt.compare);
    const res = await request(app).post('/api/auth/login').send({ email, password: 'Password123!' });
    spy.mockRestore();
    expect(res.status).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();
    const { rows } = await pool.query('SELECT 1 FROM guest_sessions WHERE account_id = $1', [id]);
    expect(rows).toHaveLength(0);
  });
});

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { Pool } from 'pg';
import passport from 'passport';
import type { Profile } from 'passport-google-oauth20';
import app from '../index';
import { db } from '../lib/db';
import { hashToken } from '../lib/tokens';
import { invalidateBetaSettings } from '../lib/beta';
import { TERMS_VERSION } from '../lib/legal';
import type { OAuthUser } from '../lib/oauth/providers/google';
import { logger } from '../lib/logger';
import { billingSettledNotDisplaced } from '../lib/displacement';
import { cancelAndRefundUnused, expireOpenCheckoutSessions, forgetCustomerContact, liveSubscriptionIds } from '../lib/billing';

// Stripe is never called: the displacement billing helpers are stand-ins.
vi.mock('../lib/billing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/billing')>()),
  cancelAndRefundUnused: vi.fn(),
  liveSubscriptionIds: vi.fn().mockResolvedValue([]),
  forgetCustomerContact: vi.fn(),
  expireOpenCheckoutSessions: vi.fn(),
}));

// Asking whether the person created an unverified account before anything
// changes: Google sign-in (held takeover), the verification link, and the
// "This wasn't me" link. Password reset is covered in terms.test.ts.

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL must be set to run tests');
const pool = new Pool({ connectionString: url });

const PASSWORD = 'Password123!';
const email = 'squatted@gmail.com';
const CHOICE_REQUIRED = { error: 'Tell us whether you created this account.', code: 'takeover_choice_required' };

async function setGate(on: boolean) {
  await pool.query('UPDATE beta_settings SET gate_on = $1, gate_first_on_at = NULL WHERE id = 1', [on]);
  invalidateBetaSettings();
}

beforeEach(async () => {
  await pool.query('TRUNCATE accounts, guest_sessions, password_reset_tokens RESTART IDENTITY CASCADE');
  await pool.query('DELETE FROM beta_invites');
  await pool.query('UPDATE beta_settings SET guest_mode_on = true WHERE id = 1');
  await setGate(false);
  vi.mocked(cancelAndRefundUnused).mockReset();
  vi.mocked(liveSubscriptionIds).mockReset().mockResolvedValue([]);
  vi.mocked(forgetCustomerContact).mockReset();
  vi.mocked(expireOpenCheckoutSessions).mockReset();
});

afterAll(async () => {
  await setGate(false);
  await pool.end();
  await db.end();
});

async function createAccount(address: string, verified: boolean): Promise<number> {
  const hash = await bcrypt.hash(PASSWORD, 4);
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO accounts (email, password_hash, zone, zone_location_label, email_verified, terms_version, terms_accepted_at)
     VALUES ($1, $2, '7b', 'Test City', $3, $4, now() - interval '1 day') RETURNING id`,
    [address, hash, verified, TERMS_VERSION],
  );
  await pool.query(`INSERT INTO gardens (owner_id, name, style, zone) VALUES ($1, 'Old Garden', 'grid', '7a')`, [
    rows[0].id,
  ]);
  return rows[0].id;
}

// Every account row in id order, without updated_at.
async function accountsSnapshot() {
  const { rows } = await pool.query('SELECT * FROM accounts ORDER BY id');
  return rows.map(({ updated_at: _updatedAt, ...rest }) => rest);
}

function sidCookie(res: request.Response): string | undefined {
  const cookies = (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
  return cookies.find((c) => c.startsWith('_vernal_sid='))?.split(';')[0];
}

async function login(address: string, password = PASSWORD): Promise<string> {
  const res = await request(app).post('/api/auth/login').send({ email: address, password });
  expect(res.status).toBe(200);
  return sidCookie(res)!;
}

function googleUser(id: string, address: string): OAuthUser {
  return {
    provider: 'google',
    accessToken: 'access',
    refreshToken: undefined,
    profile: {
      id,
      provider: 'google',
      displayName: 'Owner',
      emails: [{ value: address, verified: true }],
      photos: [],
      _json: {},
    } as unknown as Profile,
  };
}

// The Google callback with a stand-in strategy, as in authSecurity.test.ts.
async function googleCallback(address: string, cookie?: string, returnTo = '/garden') {
  const oauthUser = googleUser('g-owner', address);
  const registry = passport as unknown as { _strategy(name: string): passport.Strategy };
  const google = registry._strategy('google');
  passport.use('google', {
    name: 'google',
    authenticate(this: { success(user: unknown): void }) {
      this.success(oauthUser);
    },
  } as unknown as passport.Strategy);
  try {
    const nonce = 'd'.repeat(32);
    const state = Buffer.from(JSON.stringify({ nonce, returnTo })).toString('base64url');
    const res = await request(app)
      .get(`/api/auth/oauth/google/callback?code=abc&state=${state}`)
      .set('Cookie', [`_vernal_oauth_nonce=${nonce}`, ...(cookie ? [cookie] : [])]);
    expect(res.status).toBe(302);
    return res;
  } finally {
    passport.use('google', google);
  }
}

function takeoverCookieOf(res: request.Response): string | undefined {
  const cookies = (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
  return cookies.find((c) => c.startsWith('_vernal_takeover='));
}

// The browser half of the latest held sign-in, as the callback set it.
let takeoverCookie = '';

async function heldToken(cookie?: string): Promise<string> {
  const res = await googleCallback(email, cookie);
  expect(res.headers.location).toMatch(/\/claim-account\?token=[a-f0-9]{64}$/);
  expect(sidCookie(res)).toBeUndefined();
  takeoverCookie = takeoverCookieOf(res)!.split(';')[0];
  return new URL(res.headers.location as string).searchParams.get('token')!;
}

function inspectTakeover(token: unknown, cookie: string | null = takeoverCookie) {
  const req = request(app).post('/api/auth/takeover/inspect');
  return (cookie ? req.set('Cookie', cookie) : req).send({ token });
}

function postTakeover(body: object, cookie: string | null = takeoverCookie) {
  const req = request(app).post('/api/auth/takeover');
  return (cookie ? req.set('Cookie', cookie) : req).send(body);
}

async function sessionOf(cookie: string) {
  return (await request(app).get('/api/auth/session').set('Cookie', cookie)).body.data;
}

describe('Google sign-in on an unverified account', () => {
  it('redirects to /claim-account with a held sign-in and changes nothing else', async () => {
    const oldId = await createAccount(email, false);
    const before = await accountsSnapshot();

    const token = await heldToken();

    expect(await accountsSnapshot()).toEqual(before);
    expect((await pool.query('SELECT 1 FROM oauth_identities')).rows).toHaveLength(0);
    const { rows } = await pool.query('SELECT account_id, return_to, token_hash FROM pending_takeovers');
    expect(rows).toEqual([{ account_id: oldId, return_to: '/garden', token_hash: hashToken(token) }]);

    const info = await inspectTakeover(token);
    expect(info.status).toBe(200);
    expect(info.body).toEqual({ data: { email } });
    expect((await inspectTakeover('nope')).status).toBe(400);
    expect((await inspectTakeover(undefined)).status).toBe(400);
    // The old GET is gone: no token in a query string.
    expect((await request(app).get('/api/auth/takeover').query({ token })).status).toBe(404);
  });

  it('sets the browser cookie HttpOnly, SameSite=Lax, scoped to the takeover path, for 15 minutes', async () => {
    await createAccount(email, false);
    const res = await googleCallback(email);
    const cookie = takeoverCookieOf(res)!;
    expect(cookie).toMatch(/^_vernal_takeover=[a-f0-9]{64};/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Path=\/api\/auth\/takeover/);
    expect(cookie).toMatch(/Max-Age=900/);
    const { rows } = await pool.query('SELECT browser_hash FROM pending_takeovers');
    expect(rows).toEqual([{ browser_hash: hashToken(cookie.split(';')[0].split('=')[1]) }]);
  });

  it('the token alone, or with another browser cookie, is refused with the expired message', async () => {
    await createAccount(email, false);
    const token = await heldToken();
    const before = await accountsSnapshot();
    for (const cookie of [null, `_vernal_takeover=${'f'.repeat(64)}`]) {
      const info = await inspectTakeover(token, cookie);
      expect(info.status).toBe(400);
      expect(info.body).toEqual({ error: 'This sign-in has expired. Please sign in with Google again.' });
      const res = await postTakeover({ token, choice: 'not_mine' }, cookie);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'This sign-in has expired. Please sign in with Google again.' });
      expect(sidCookie(res)).toBeUndefined();
    }
    expect(await accountsSnapshot()).toEqual(before);
    expect(cancelAndRefundUnused).not.toHaveBeenCalled();
    expect((await postTakeover({ token, choice: 'mine' })).status).toBe(200);
  });

  it("'not_mine' with under 2 minutes left is refused before Stripe, with the expired message", async () => {
    const oldId = await createAccount(email, false);
    await pool.query(`UPDATE accounts SET stripe_subscription_id = 'sub_1' WHERE id = $1`, [oldId]);
    const token = await heldToken();
    await pool.query("UPDATE pending_takeovers SET expires_at = now() + interval '90 seconds'");
    const before = await accountsSnapshot();
    const res = await postTakeover({ token, choice: 'not_mine' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'This sign-in has expired. Please sign in with Google again.' });
    expect(cancelAndRefundUnused).not.toHaveBeenCalled();
    expect(await accountsSnapshot()).toEqual(before);
  });

  it('holds the guest session only when the browser is a guest, not signed in to another account', async () => {
    await createAccount(email, false);
    const guest = await request(app).post('/api/auth/guest');
    const guestCookie = sidCookie(guest)!;
    await heldToken(guestCookie);
    const { rows: guestRows } = await pool.query(
      `SELECT p.guest_session_id = g.id AS is_guest
         FROM pending_takeovers p JOIN guest_sessions g ON g.account_id IS NULL`,
    );
    expect(guestRows).toEqual([{ is_guest: true }]);

    await pool.query('DELETE FROM pending_takeovers');
    await createAccount('other@example.com', true);
    await heldToken(await login('other@example.com'));
    const { rows } = await pool.query('SELECT guest_session_id FROM pending_takeovers');
    expect(rows).toEqual([{ guest_session_id: null }]);
  });

  it("'mine' keeps the account and its data, links Google, signs the browser in and holds it at the Terms", async () => {
    const oldId = await createAccount(email, false);
    const squatterCookie = await login(email);
    const token = await heldToken();

    const res = await postTakeover({ token, choice: 'mine' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { redirectTo: '/garden' } });
    const cookie = sidCookie(res)!;
    // The browser cookie is cleared on completion.
    expect(takeoverCookieOf(res)).toMatch(/^_vernal_takeover=;.*Expires=Thu, 01 Jan 1970/);

    const session = await sessionOf(cookie);
    expect(session.authenticated).toBe(true);
    expect(session.account.id).toBe(oldId);
    expect(session.account.termsRequired).toBe(true);
    expect((await sessionOf(squatterCookie)).authenticated).toBe(false);

    const { rows } = await pool.query(
      `SELECT email_verified, password_hash, displaced_at, claimed_at IS NOT NULL AS claimed FROM accounts WHERE id = $1`,
      [oldId],
    );
    expect(rows[0]).toEqual({ email_verified: true, password_hash: null, displaced_at: null, claimed: true });
    expect((await pool.query('SELECT account_id FROM oauth_identities')).rows).toEqual([{ account_id: oldId }]);
    expect((await pool.query('SELECT 1 FROM accounts')).rows).toHaveLength(1);

    const accept = await request(app)
      .post('/api/me/terms')
      .set('Cookie', cookie)
      .send({ accept: true, version: TERMS_VERSION });
    expect(accept.status).toBe(204);
    const gardens = await request(app).get('/api/gardens').set('Cookie', cookie);
    expect(gardens.body.data.map((g: { name: string }) => g.name)).toEqual(['Old Garden']);

    // Single use.
    expect((await postTakeover({ token, choice: 'mine' })).status).toBe(400);
  });

  it("'not_mine' displaces the account, makes a new one and signs the browser in to it", async () => {
    const oldId = await createAccount(email, false);
    await pool.query(`UPDATE accounts SET stripe_customer_id = 'cus_1', stripe_subscription_id = 'sub_1' WHERE id = $1`, [
      oldId,
    ]);
    const token = await heldToken();

    const res = await postTakeover({ token, choice: 'not_mine' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { redirectTo: '/garden' } });
    expect(cancelAndRefundUnused).toHaveBeenCalledWith('sub_1', oldId);
    expect(forgetCustomerContact).toHaveBeenCalledWith('cus_1', oldId);

    const session = await sessionOf(sidCookie(res)!);
    expect(session.account.id).not.toBe(oldId);
    expect(session.account.email).toBe(email);
    const { rows } = await pool.query('SELECT email, displaced_at IS NOT NULL AS displaced FROM accounts WHERE id = $1', [
      oldId,
    ]);
    expect(rows[0]).toEqual({ email: `displaced-${oldId}@displaced.invalid`, displaced: true });
    const gardens = await request(app).get('/api/gardens').set('Cookie', sidCookie(res)!);
    expect(gardens.body.data).toEqual([]);
  });

  it('refuses a missing or unknown choice, and an unknown, used or expired token', async () => {
    await createAccount(email, false);
    const token = await heldToken();
    const missing = await postTakeover({ token });
    expect(missing.status).toBe(400);
    expect(missing.body).toEqual(CHOICE_REQUIRED);
    expect((await postTakeover({ token, choice: 'yes' })).status).toBe(400);
    expect((await postTakeover({ token: 'nope', choice: 'mine' })).status).toBe(400);

    await pool.query("UPDATE pending_takeovers SET expires_at = now() - interval '1 second'");
    const expired = await postTakeover({ token, choice: 'mine' });
    expect(expired.status).toBe(400);
    expect(sidCookie(expired)).toBeUndefined();
    expect((await inspectTakeover(token)).status).toBe(400);
  });

  it("'not_mine' from someone not invited under the gate: 403, nothing changed", async () => {
    await createAccount(email, false);
    await setGate(true);
    const token = await heldToken();
    const before = await accountsSnapshot();

    const res = await postTakeover({ token, choice: 'not_mine' });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "That email address isn't on the invite list.", code: 'not_invited' });
    expect(await accountsSnapshot()).toEqual(before);
    expect(sidCookie(res)).toBeUndefined();
    expect(cancelAndRefundUnused).not.toHaveBeenCalled();
  });

  it('a verified account with a password is still claimed in place without a question', async () => {
    const id = await createAccount(email, true);
    const res = await googleCallback(email);
    expect(res.headers.location).toMatch(/\/garden$/);
    expect((await sessionOf(sidCookie(res)!)).account.id).toBe(id);
    expect((await pool.query('SELECT 1 FROM pending_takeovers')).rows).toHaveLength(0);
    const { rows } = await pool.query('SELECT password_hash, claimed_at IS NOT NULL AS claimed FROM accounts');
    expect(rows).toEqual([{ password_hash: null, claimed: true }]);
  });
});

const VERIFY_TOKEN = 'verify-token';

async function verificationToken(accountId: number, address = email) {
  await pool.query(
    `INSERT INTO email_verification_tokens (account_id, email, token_hash, expires_at)
     VALUES ($1, $2, $3, now() + interval '1 day')`,
    [accountId, address, hashToken(VERIFY_TOKEN)],
  );
}

function inspectVerification(token: unknown, cookie?: string) {
  const req = request(app).post('/api/auth/verify-email/inspect');
  return (cookie ? req.set('Cookie', cookie) : req).send({ token });
}

async function verificationUsed(): Promise<boolean | undefined> {
  const { rows } = await pool.query('SELECT used_at IS NOT NULL AS used FROM email_verification_tokens');
  return rows[0]?.used;
}

describe('the verification link', () => {
  it('verifies straight away when signed in as the account since before the link was sent', async () => {
    const id = await createAccount(email, false);
    const cookie = await login(email);
    await verificationToken(id);

    const inspect = await inspectVerification(VERIFY_TOKEN, cookie);
    expect(inspect.body).toEqual({ data: { signedInAsAccount: true, unverifiedAccount: true, email } });

    const res = await request(app).post('/api/auth/verify-email').set('Cookie', cookie).send({ token: VERIFY_TOKEN });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { verified: true } });
    const { rows } = await pool.query('SELECT email_verified, claimed_at FROM accounts');
    expect(rows).toEqual([{ email_verified: true, claimed_at: null }]);
    expect((await sessionOf(cookie)).authenticated).toBe(true);
  });

  it('asks a session that signed in to the account after the link was sent', async () => {
    const id = await createAccount(email, false);
    await verificationToken(id);
    const cookie = await login(email);

    const inspect = await inspectVerification(VERIFY_TOKEN, cookie);
    expect(inspect.body).toEqual({ data: { signedInAsAccount: false, unverifiedAccount: true, email } });
    const res = await request(app).post('/api/auth/verify-email').set('Cookie', cookie).send({ token: VERIFY_TOKEN });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ ...CHOICE_REQUIRED, email });
    expect(await verificationUsed()).toBe(false);
  });

  it("an explicit 'not_mine' removes the account even from a session signed in to it", async () => {
    const id = await createAccount(email, false);
    const cookie = await login(email);
    await verificationToken(id);

    const res = await request(app)
      .post('/api/auth/verify-email')
      .set('Cookie', cookie)
      .send({ token: VERIFY_TOKEN, choice: 'not_mine' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { removed: true } });
    const { rows } = await pool.query('SELECT email, displaced_at IS NOT NULL AS displaced FROM accounts');
    expect(rows).toEqual([{ email: `displaced-${id}@displaced.invalid`, displaced: true }]);
    expect((await sessionOf(cookie)).authenticated).toBe(false);
  });

  it("'not_mine' with under 2 minutes left on the link is refused before Stripe", async () => {
    const id = await createAccount(email, false);
    await pool.query(`UPDATE accounts SET stripe_subscription_id = 'sub_1' WHERE id = $1`, [id]);
    await verificationToken(id);
    await pool.query("UPDATE email_verification_tokens SET expires_at = now() + interval '90 seconds'");
    const before = await accountsSnapshot();
    const nearlyExpired = { error: 'This verification link has nearly expired. Please request a new one.' };

    const verify = await request(app).post('/api/auth/verify-email').send({ token: VERIFY_TOKEN, choice: 'not_mine' });
    expect(verify.status).toBe(400);
    expect(verify.body).toEqual(nearlyExpired);
    const notMe = await request(app).post('/api/auth/not-me').send({ token: VERIFY_TOKEN });
    expect(notMe.status).toBe(400);
    expect(notMe.body).toEqual(nearlyExpired);
    expect(cancelAndRefundUnused).not.toHaveBeenCalled();
    expect(await accountsSnapshot()).toEqual(before);
    expect(await verificationUsed()).toBe(false);
  });

  it('asks first when not signed in as the account; the token stays usable', async () => {
    const id = await createAccount(email, false);
    await verificationToken(id);
    await createAccount('other@example.com', true);
    const otherCookie = await login('other@example.com');

    const inspect = await inspectVerification(VERIFY_TOKEN);
    expect(inspect.status).toBe(200);
    expect(inspect.body).toEqual({ data: { signedInAsAccount: false, unverifiedAccount: true, email } });
    expect(await verificationUsed()).toBe(false);

    const before = await accountsSnapshot();
    for (const cookie of [undefined, otherCookie]) {
      const req = request(app).post('/api/auth/verify-email');
      const res = await (cookie ? req.set('Cookie', cookie) : req).send({ token: VERIFY_TOKEN });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ ...CHOICE_REQUIRED, email });
    }
    expect((await request(app).post('/api/auth/verify-email').send({ token: VERIFY_TOKEN, choice: 'x' })).status).toBe(400);
    expect(await accountsSnapshot()).toEqual(before);
    expect(await verificationUsed()).toBe(false);
  });

  it("'mine' verifies and claims the account, signing out its sessions", async () => {
    const id = await createAccount(email, false);
    await verificationToken(id);
    const squatterCookie = await login(email);
    await pool.query("UPDATE accounts SET beta_terms_version = 'b1', beta_terms_accepted_at = now() WHERE id = $1", [id]);
    // A pending email change and a held Google sign-in don't survive the claim.
    await pool.query("UPDATE accounts SET pending_email = 'elsewhere@example.com' WHERE id = $1", [id]);
    await pool.query(
      `INSERT INTO email_change_tokens (account_id, token_hash, new_email, expires_at)
       VALUES ($1, 'change-hash', 'elsewhere@example.com', now() + interval '1 hour')`,
      [id],
    );
    await pool.query(
      `INSERT INTO pending_takeovers (token_hash, account_id, provider, provider_user_id, email, display_name,
                                      access_token_encrypted, expires_at)
       VALUES ('held-hash', $1, 'google', 'g-1', $2, 'Owner', '\\x00', now() + interval '10 minutes')`,
      [id, email],
    );
    const { rows: hashBefore } = await pool.query('SELECT password_hash FROM accounts WHERE id = $1', [id]);

    const res = await request(app).post('/api/auth/verify-email').send({ token: VERIFY_TOKEN, choice: 'mine' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { verified: true } });
    expect(sidCookie(res)).toBeUndefined();

    const { rows } = await pool.query(
      `SELECT email_verified, terms_version, terms_accepted_at, beta_terms_version, beta_terms_accepted_at,
              claimed_at > now() - interval '1 minute' AS recently_claimed, displaced_at
         FROM accounts WHERE id = $1`,
      [id],
    );
    expect(rows[0]).toEqual({
      email_verified: true,
      terms_version: null,
      terms_accepted_at: null,
      beta_terms_version: null,
      beta_terms_accepted_at: null,
      recently_claimed: true,
      displaced_at: null,
    });
    const { rows: after } = await pool.query('SELECT pending_email, password_hash FROM accounts WHERE id = $1', [id]);
    // The password stays: the creator signs in with it and gets the Terms prompt.
    expect(after[0]).toEqual({ pending_email: null, password_hash: hashBefore[0].password_hash });
    expect((await pool.query('SELECT 1 FROM email_change_tokens')).rows).toHaveLength(0);
    expect((await pool.query('SELECT 1 FROM pending_takeovers')).rows).toHaveLength(0);
    expect((await sessionOf(squatterCookie)).authenticated).toBe(false);
    const relogin = await login(email);
    expect((await sessionOf(relogin)).account.termsRequired).toBe(true);
    expect((await request(app).post('/api/auth/verify-email').send({ token: VERIFY_TOKEN, choice: 'mine' })).status).toBe(400);
  });

  it("'not_mine' removes the account and makes no new one", async () => {
    const id = await createAccount(email, false);
    await verificationToken(id);

    const res = await request(app).post('/api/auth/verify-email').send({ token: VERIFY_TOKEN, choice: 'not_mine' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { removed: true } });
    const { rows } = await pool.query('SELECT id, email, displaced_at IS NOT NULL AS displaced FROM accounts');
    expect(rows).toEqual([{ id, email: `displaced-${id}@displaced.invalid`, displaced: true }]);
  });

  it('an already verified account verifies without a question (today’s behaviour)', async () => {
    const id = await createAccount(email, true);
    await verificationToken(id);
    const inspect = await inspectVerification(VERIFY_TOKEN);
    expect(inspect.body).toEqual({ data: { signedInAsAccount: false, unverifiedAccount: false, email } });
    const res = await request(app).post('/api/auth/verify-email').send({ token: VERIFY_TOKEN });
    expect(res.status).toBe(200);
    expect(await verificationUsed()).toBe(true);
    const { rows } = await pool.query('SELECT claimed_at FROM accounts');
    expect(rows).toEqual([{ claimed_at: null }]);
  });

  it("'not_mine' on an account that is already verified: 409 already_verified, the link unused", async () => {
    const id = await createAccount(email, true);
    await verificationToken(id);
    const before = await accountsSnapshot();
    const res = await request(app).post('/api/auth/verify-email').send({ token: VERIFY_TOKEN, choice: 'not_mine' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('already_verified');
    expect(await accountsSnapshot()).toEqual(before);
    expect(await verificationUsed()).toBe(false);
    expect(cancelAndRefundUnused).not.toHaveBeenCalled();
  });

  it('inspect rejects an unknown or missing token; the old GET is gone', async () => {
    expect((await inspectVerification('nope')).status).toBe(400);
    expect((await inspectVerification(undefined)).status).toBe(400);
    expect((await request(app).get('/api/auth/verify-email/inspect').query({ token: VERIFY_TOKEN })).status).toBe(404);
  });

  it('inspect rejects an expired token without giving the address', async () => {
    const id = await createAccount(email, false);
    await pool.query(
      `INSERT INTO email_verification_tokens (account_id, email, token_hash, expires_at)
       VALUES ($1, $2, $3, now() - interval '1 minute')`,
      [id, email, hashToken(VERIFY_TOKEN)],
    );
    const expired = await inspectVerification(VERIFY_TOKEN);
    expect(expired.status).toBe(400);
    expect(expired.body).toEqual({ error: 'This verification link is invalid or has expired.' });
  });

  it("inspect rejects a token for an address the account no longer has, without giving either address", async () => {
    const id = await createAccount(email, false);
    await verificationToken(id, 'old-address@example.com');
    const stale = await inspectVerification(VERIFY_TOKEN);
    expect(stale.status).toBe(400);
    expect(stale.body).toEqual({ error: 'This verification link is invalid or has expired.' });
  });
});

describe('POST /api/auth/not-me', () => {
  it('settles billing, removes the account without making a new one, consumes the link, signs nobody in', async () => {
    const id = await createAccount(email, false);
    await pool.query(
      `UPDATE accounts SET stripe_customer_id = 'cus_1', stripe_subscription_id = 'sub_1',
                           stripe_lifetime_payment_intent = 'pi_1' WHERE id = $1`,
      [id],
    );
    vi.mocked(liveSubscriptionIds).mockResolvedValue(['sub_9']);
    await verificationToken(id);
    const squatterCookie = await login(email);

    const res = await request(app).post('/api/auth/not-me').send({ token: VERIFY_TOKEN });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { removed: true } });
    expect(sidCookie(res)).toBeUndefined();

    expect(vi.mocked(cancelAndRefundUnused).mock.calls).toEqual([
      ['sub_1', id],
      ['sub_9', id],
    ]);
    expect(forgetCustomerContact).toHaveBeenCalledWith('cus_1', id);
    // Open Checkout sessions are expired before any subscription is cancelled.
    expect(expireOpenCheckoutSessions).toHaveBeenCalledWith('cus_1', id);
    expect(vi.mocked(expireOpenCheckoutSessions).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(cancelAndRefundUnused).mock.invocationCallOrder[0],
    );
    const { rows } = await pool.query(
      `SELECT id, email, password_hash, displaced_at IS NOT NULL AS displaced,
              deletion_scheduled_at IS NOT NULL AS deleted FROM accounts`,
    );
    expect(rows).toEqual([
      { id, email: `displaced-${id}@displaced.invalid`, password_hash: null, displaced: true, deleted: true },
    ]);
    expect((await sessionOf(squatterCookie)).authenticated).toBe(false);
    expect(await verificationUsed()).toBeUndefined();
    expect((await request(app).post('/api/auth/not-me').send({ token: VERIFY_TOKEN })).status).toBe(400);
  });

  it('409 for an account that is already verified, nothing changed', async () => {
    const id = await createAccount(email, true);
    await verificationToken(id);
    const before = await accountsSnapshot();
    const res = await request(app).post('/api/auth/not-me').send({ token: VERIFY_TOKEN });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('already_verified');
    expect(await accountsSnapshot()).toEqual(before);
    expect(cancelAndRefundUnused).not.toHaveBeenCalled();
  });

  it('400 for an unknown or missing token', async () => {
    expect((await request(app).post('/api/auth/not-me').send({ token: 'nope' })).status).toBe(400);
    expect((await request(app).post('/api/auth/not-me').send({})).status).toBe(400);
  });

  it('a Stripe failure changes nothing and the link stays usable', async () => {
    const id = await createAccount(email, false);
    await pool.query(`UPDATE accounts SET stripe_subscription_id = 'sub_1' WHERE id = $1`, [id]);
    await verificationToken(id);
    vi.mocked(cancelAndRefundUnused).mockRejectedValueOnce(new Error('stripe down'));
    const before = await accountsSnapshot();

    expect((await request(app).post('/api/auth/not-me').send({ token: VERIFY_TOKEN })).status).toBe(502);
    expect(await accountsSnapshot()).toEqual(before);
    expect(await verificationUsed()).toBe(false);
    expect((await request(app).post('/api/auth/not-me').send({ token: VERIFY_TOKEN })).status).toBe(200);
  });

  it('a GET (a mail scanner following the link) does nothing server-side', async () => {
    const id = await createAccount(email, false);
    await verificationToken(id);
    const before = await accountsSnapshot();
    for (const path of ['/api/auth/not-me', `/api/auth/not-me?token=${VERIFY_TOKEN}`, `/not-me?token=${VERIFY_TOKEN}`]) {
      const res = await request(app).get(path);
      expect(res.status).not.toBe(200);
    }
    expect(await accountsSnapshot()).toEqual(before);
    expect(await verificationUsed()).toBe(false);
    expect(cancelAndRefundUnused).not.toHaveBeenCalled();
  });
});

describe('cross-site requests (login CSRF)', () => {
  const frontend = process.env.FRONTEND_URL ?? 'http://localhost:5173';

  it('refuses a cross-site login and takeover before they run', async () => {
    await createAccount(email, true);
    for (const headers of [{ 'Sec-Fetch-Site': 'cross-site' }, { Origin: 'https://evil.example' }]) {
      const res = await request(app)
        .post('/api/auth/login')
        .set(headers)
        .type('form')
        .send({ email, password: PASSWORD });
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'Cross-site request refused.' });
      expect(sidCookie(res)).toBeUndefined();
      const takeover = await request(app).post('/api/auth/takeover').set(headers).send({ token: 'x', choice: 'mine' });
      expect(takeover.status).toBe(403);
    }
  });

  it('lets the app itself, and header-less clients, through', async () => {
    await createAccount(email, true);
    const same = await request(app)
      .post('/api/auth/login')
      .set({ Origin: frontend, 'Sec-Fetch-Site': 'same-origin' })
      .send({ email, password: PASSWORD });
    expect(same.status).toBe(200);
    expect((await request(app).post('/api/auth/login').send({ email, password: PASSWORD })).status).toBe(200);
  });

  it('leaves the Stripe webhook path alone', async () => {
    const res = await request(app).post('/api/webhooks/stripe').set('Origin', 'https://evil.example').send('{}');
    expect(res.status).not.toBe(403);
  });
});

describe('billingSettledNotDisplaced', () => {
  it('alerts an operator, unless a racing request displaced the account after all', async () => {
    const id = await createAccount(email, false);
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    try {
      await billingSettledNotDisplaced(id);
      expect(errorSpy).toHaveBeenCalledWith('Displacement billing settled but account not displaced', undefined, {
        accountId: id,
      });
      expect(warnSpy).not.toHaveBeenCalled();

      errorSpy.mockClear();
      await pool.query('UPDATE accounts SET displaced_at = now() WHERE id = $1', [id]);
      await billingSettledNotDisplaced(id);
      expect(warnSpy).toHaveBeenCalledWith('Displacement billing settled; account already displaced by another request', {
        accountId: id,
      });
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});

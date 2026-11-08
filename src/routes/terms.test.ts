import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { Pool } from 'pg';
import app from '../index';
import { TERMS_VERSION } from '../lib/legal';
import { TERMS_ERROR } from '../middleware/betaTerms';
import { hashToken } from '../lib/tokens';
import { invalidateBetaSettings } from '../lib/beta';
import { cancelAndRefundUnused, liveSubscriptionIds } from '../lib/billing';
import { logger } from '../lib/logger';

// Stripe is never called: the displacement refund helper is a stand-in.
vi.mock('../lib/billing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/billing')>()),
  cancelAndRefundUnused: vi.fn(),
  liveSubscriptionIds: vi.fn().mockResolvedValue([]),
  forgetCustomerContact: vi.fn(),
  expireOpenCheckoutSessions: vi.fn(),
}));

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL must be set to run tests');

const pool = new Pool({ connectionString: url });
const PASSWORD = 'Password123!';
const email = 'reclaimed@example.com';

// claimed: claimed_at set after any acceptance, as a claim leaves it.
async function createUser(opts: { claimed?: boolean; verified?: boolean; termsVersion?: string | null } = {}) {
  const { claimed = false, verified = true, termsVersion = null } = opts;
  const hash = await bcrypt.hash(PASSWORD, 4);
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO accounts
       (email, password_hash, zone, zone_location_label, email_verified,
        terms_version, terms_accepted_at, claimed_at)
     VALUES ($1, $2, '7b', 'Test City', $3, $4::text,
             CASE WHEN $4::text IS NOT NULL THEN now() - interval '1 day' END,
             CASE WHEN $5::boolean THEN now() END)
     RETURNING id`,
    [email, hash, verified, termsVersion, claimed],
  );
  return rows[0].id;
}

async function loginAgent(password = PASSWORD) {
  const agent = request.agent(app);
  await agent.post('/api/auth/guest');
  const res = await agent.post('/api/auth/login').send({ email, password });
  expect(res.status).toBe(200);
  return agent;
}

async function termsRow() {
  const { rows } = await pool.query(
    'SELECT terms_version, terms_accepted_at, claimed_at FROM accounts WHERE email = $1',
    [email],
  );
  return rows[0] as { terms_version: string | null; terms_accepted_at: Date | null; claimed_at: Date | null };
}

const RESET_TOKEN = 'terms-reset-token';

async function insertResetToken(accountId: number, expiresIn = '1 hour') {
  await pool.query(
    `INSERT INTO password_reset_tokens (account_id, token_hash, expires_at)
     VALUES ($1, $2, now() + $3::interval)`,
    [accountId, hashToken(RESET_TOKEN), expiresIn],
  );
}

async function postReset(accountId: number, choice?: 'mine' | 'not_mine') {
  await insertResetToken(accountId);
  return request(app).post('/api/auth/reset-password').send({ token: RESET_TOKEN, password: 'NewPassword1!', choice });
}

async function resetPassword(accountId: number, choice?: 'mine' | 'not_mine') {
  expect((await postReset(accountId, choice)).status).toBe(200);
}

// Every account row in id order, without updated_at.
async function accountsSnapshot() {
  const { rows } = await pool.query('SELECT * FROM accounts ORDER BY id');
  return rows.map(({ updated_at: _updatedAt, ...rest }) => rest);
}

async function resetTokenUsedAt(accountId: number) {
  const { rows } = await pool.query('SELECT used_at FROM password_reset_tokens WHERE account_id = $1', [accountId]);
  return rows[0]?.used_at;
}

async function setGate(on: boolean) {
  await pool.query('UPDATE beta_settings SET gate_on = $1, gate_first_on_at = NULL WHERE id = 1', [on]);
  invalidateBetaSettings();
}

beforeEach(async () => {
  await pool.query('TRUNCATE accounts, guest_sessions, password_reset_tokens RESTART IDENTITY CASCADE');
  await pool.query('DELETE FROM beta_invites');
  await setGate(false);
  vi.mocked(cancelAndRefundUnused).mockReset();
  vi.mocked(liveSubscriptionIds).mockReset().mockResolvedValue([]);
});

afterAll(async () => {
  await setGate(false);
  await pool.end();
});

describe('Terms gate after a claim', () => {
  it('holds a claimed account with terms_required and reports it on the session', async () => {
    await createUser({ claimed: true });
    const agent = await loginAgent();

    const gardens = await agent.get('/api/gardens');
    expect(gardens.status).toBe(403);
    expect(gardens.body).toEqual(TERMS_ERROR);
    expect((await agent.get('/api/me')).status).toBe(403);

    const session = await agent.get('/api/auth/session');
    expect(session.body.data.account.termsRequired).toBe(true);
    expect(session.body.data.account.termsVersion).toBe(TERMS_VERSION);
  });

  it('holds a claimed account whose acceptance predates the claim', async () => {
    await createUser({ claimed: true, termsVersion: TERMS_VERSION });
    const agent = await loginAgent();
    expect((await agent.get('/api/gardens')).body).toEqual(TERMS_ERROR);
  });

  it('accepting the current version records it and lifts the hold', async () => {
    await createUser({ claimed: true });
    const agent = await loginAgent();

    const accept = await agent.post('/api/me/terms').send({ accept: true, version: TERMS_VERSION });
    expect(accept.status).toBe(204);
    const row = await termsRow();
    expect(row.terms_version).toBe(TERMS_VERSION);
    expect(row.terms_accepted_at!.getTime()).toBeGreaterThan(row.claimed_at!.getTime());

    expect((await agent.get('/api/gardens')).status).toBe(200);
    expect((await agent.get('/api/auth/session')).body.data.account.termsRequired).toBe(false);
  });

  it('rejects a stale version with 409 and keeps the hold', async () => {
    await createUser({ claimed: true });
    const agent = await loginAgent();

    const res = await agent.post('/api/me/terms').send({ accept: true, version: '2020-01-01' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('terms_version_changed');
    expect((await termsRow()).terms_version).toBeNull();
    expect((await agent.get('/api/gardens')).status).toBe(403);
  });

  it.each([
    ['no body', undefined],
    ['accept false', { accept: false, version: TERMS_VERSION }],
    ['accept as a string', { accept: 'true', version: TERMS_VERSION }],
  ])('rejects acceptance with %s', async (_label, body) => {
    await createUser({ claimed: true });
    const agent = await loginAgent();
    const res = await agent.post('/api/me/terms').send(body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('terms_required');
    expect((await termsRow()).terms_version).toBeNull();
  });

  it('rejects a missing version', async () => {
    await createUser({ claimed: true });
    const agent = await loginAgent();
    expect((await agent.post('/api/me/terms').send({ accept: true })).status).toBe(409);
  });

  it('does not hold an account with NULL Terms that was never claimed', async () => {
    await createUser();
    const agent = await loginAgent();
    expect((await agent.get('/api/gardens')).status).toBe(200);
    expect((await agent.get('/api/auth/session')).body.data.account.termsRequired).toBe(false);
  });

  it('requires an account: a guest cannot accept', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/guest');
    expect((await agent.post('/api/me/terms').send({ accept: true, version: TERMS_VERSION })).status).toBe(401);
  });
});

describe('POST /api/auth/reset-password and the Terms', () => {
  it("on an unverified account answered 'not_mine': deletes it and gives the owner a new account held at the Terms", async () => {
    const oldId = await createUser({ verified: false, termsVersion: TERMS_VERSION });
    await pool.query(`INSERT INTO gardens (owner_id, name, style, zone) VALUES ($1, 'Old Garden', 'grid', '7a')`, [oldId]);
    await pool.query(
      `INSERT INTO guest_sessions (token_hash, expires_at, account_id, migrated_at)
       VALUES ('squatter-session', now() + interval '1 day', $1, now())`,
      [oldId],
    );
    const res = await postReset(oldId, 'not_mine');
    expect(res.status).toBe(200);
    expect(res.body.data.newAccount).toBe(true);

    const { rows: old } = await pool.query(
      `SELECT email, password_hash, deletion_scheduled_at IS NOT NULL AS deleted, displaced_at IS NOT NULL AS displaced
         FROM accounts WHERE id = $1`,
      [oldId],
    );
    expect(old[0]).toEqual({ email: `displaced-${oldId}@displaced.invalid`, password_hash: null, deleted: true, displaced: true });
    expect((await pool.query('SELECT 1 FROM guest_sessions WHERE account_id = $1 AND expires_at > now()', [oldId])).rows).toHaveLength(0);
    // The token is spent (deleted with the earlier account's other tokens).
    const again = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: RESET_TOKEN, password: 'Other123!', choice: 'not_mine' });
    expect(again.status).toBe(400);

    const { rows: fresh } = await pool.query(
      'SELECT id, email_verified, terms_version, terms_accepted_at, claimed_at FROM accounts WHERE email = $1',
      [email],
    );
    expect(fresh[0].id).not.toBe(oldId);
    expect(fresh[0].email_verified).toBe(true);
    expect(fresh[0].terms_version).toBeNull();
    expect(fresh[0].terms_accepted_at).toBeNull();
    expect(fresh[0].claimed_at).not.toBeNull();

    const agent = await loginAgent('NewPassword1!');
    const held = await agent.get('/api/gardens');
    expect(held.status).toBe(403);
    expect(held.body).toEqual(TERMS_ERROR);
    expect((await agent.post('/api/me/terms').send({ accept: true, version: TERMS_VERSION })).status).toBe(204);
    const gardens = await agent.get('/api/gardens');
    expect(gardens.status).toBe(200);
    expect(gardens.body.data).toEqual([]);
    expect(cancelAndRefundUnused).not.toHaveBeenCalled();
  });

  it("'not_mine' with subscriptions: refunds the stored one and every other live one on the customer first", async () => {
    const oldId = await createUser({ verified: false });
    await pool.query(
      `UPDATE accounts SET stripe_customer_id = 'cus_1', stripe_subscription_id = 'sub_1' WHERE id = $1`,
      [oldId],
    );
    vi.mocked(liveSubscriptionIds).mockResolvedValue(['sub_1', 'sub_2']);
    await resetPassword(oldId, 'not_mine');
    expect(liveSubscriptionIds).toHaveBeenCalledWith('cus_1', oldId);
    expect(vi.mocked(cancelAndRefundUnused).mock.calls).toEqual([
      ['sub_1', oldId],
      ['sub_2', oldId],
    ]);
  });

  it("'not_mine': a Stripe failure refuses the reset and changes nothing", async () => {
    const oldId = await createUser({ verified: false });
    await pool.query(`UPDATE accounts SET stripe_subscription_id = 'sub_1' WHERE id = $1`, [oldId]);
    vi.mocked(cancelAndRefundUnused).mockRejectedValue(new Error('stripe down'));
    const before = await accountsSnapshot();

    expect((await postReset(oldId, 'not_mine')).status).toBe(502);
    expect(await accountsSnapshot()).toEqual(before);
    expect(await resetTokenUsedAt(oldId)).toBeNull();
  });

  it("'not_mine' under the gate: an uninvited owner is refused and nothing changes", async () => {
    const oldId = await createUser({ verified: false });
    await setGate(true);
    const before = await accountsSnapshot();

    const res = await postReset(oldId, 'not_mine');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "That email address isn't on the invite list.", code: 'not_invited' });
    expect(await accountsSnapshot()).toEqual(before);
    expect(cancelAndRefundUnused).not.toHaveBeenCalled();
  });

  it("'not_mine' with under 10 minutes left on the link: refused before Stripe, nothing changes", async () => {
    const oldId = await createUser({ verified: false });
    await pool.query(`UPDATE accounts SET stripe_subscription_id = 'sub_1' WHERE id = $1`, [oldId]);
    await insertResetToken(oldId, '9 minutes');
    const before = await accountsSnapshot();

    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: RESET_TOKEN, password: 'NewPassword1!', choice: 'not_mine' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/request a new one/);
    expect(cancelAndRefundUnused).not.toHaveBeenCalled();
    expect(liveSubscriptionIds).not.toHaveBeenCalled();
    expect(await accountsSnapshot()).toEqual(before);
    expect(await resetTokenUsedAt(oldId)).toBeNull();
  });

  it("'not_mine' when the account is verified while Stripe settles: 409, not displaced, an operator alert, no lifetime alert", async () => {
    const oldId = await createUser({ verified: false });
    await pool.query(
      `UPDATE accounts SET stripe_customer_id = 'cus_1', stripe_lifetime_payment_intent = 'pi_1' WHERE id = $1`,
      [oldId],
    );
    vi.mocked(liveSubscriptionIds).mockImplementation(async () => {
      await pool.query('UPDATE accounts SET email_verified = true WHERE id = $1', [oldId]);
      return [];
    });
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    try {
      expect((await postReset(oldId, 'not_mine')).status).toBe(409);
      // Logged after the response is sent, once displaced_at has been checked.
      await vi.waitFor(() => expect(errorSpy).toHaveBeenCalled());
      expect(errorSpy.mock.calls.map(([msg]) => msg)).toEqual(['Displacement billing settled but account not displaced']);
      expect(errorSpy).toHaveBeenCalledWith('Displacement billing settled but account not displaced', undefined, {
        accountId: oldId,
      });
    } finally {
      errorSpy.mockRestore();
    }
    const { rows } = await pool.query('SELECT displaced_at FROM accounts');
    expect(rows).toEqual([{ displaced_at: null }]);
    expect(await resetTokenUsedAt(oldId)).toBeNull();
  });

  it('on an unverified account with no choice: 409 and the token stays usable', async () => {
    const id = await createUser({ verified: false, termsVersion: TERMS_VERSION });
    const before = await accountsSnapshot();

    const res = await postReset(id);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Tell us whether you created this account.', code: 'takeover_choice_required' });
    expect(await accountsSnapshot()).toEqual(before);
    expect(await resetTokenUsedAt(id)).toBeNull();

    const bad = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: RESET_TOKEN, password: 'NewPassword1!', choice: 'maybe' });
    expect(bad.status).toBe(400);

    const ok = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: RESET_TOKEN, password: 'NewPassword1!', choice: 'mine' });
    expect(ok.status).toBe(200);
  });

  it("'mine': keeps the account and its data, verified, with the new password and held at the Terms", async () => {
    const id = await createUser({ verified: false, termsVersion: TERMS_VERSION });
    await pool.query(
      `UPDATE accounts SET pending_email = 'other@example.com', beta_terms_version = 'b1', beta_terms_accepted_at = now()
        WHERE id = $1`,
      [id],
    );
    await pool.query(`INSERT INTO gardens (owner_id, name, style, zone) VALUES ($1, 'Kept Garden', 'grid', '7a')`, [id]);
    const oldSession = await loginAgent();

    await resetPassword(id, 'mine');

    const { rows } = await pool.query(
      `SELECT id, email, email_verified, pending_email, terms_version, terms_accepted_at, beta_terms_version,
              beta_terms_accepted_at, displaced_at, claimed_at > now() - interval '1 minute' AS recently_claimed
         FROM accounts`,
    );
    expect(rows).toEqual([
      {
        id,
        email,
        email_verified: true,
        pending_email: null,
        terms_version: null,
        terms_accepted_at: null,
        beta_terms_version: null,
        beta_terms_accepted_at: null,
        displaced_at: null,
        recently_claimed: true,
      },
    ]);
    expect((await oldSession.get('/api/auth/session')).body.data.authenticated).toBe(false);
    expect(cancelAndRefundUnused).not.toHaveBeenCalled();

    const agent = await loginAgent('NewPassword1!');
    expect((await agent.get('/api/gardens')).body).toEqual(TERMS_ERROR);
    expect((await agent.post('/api/me/terms').send({ accept: true, version: TERMS_VERSION })).status).toBe(204);
    const gardens = await agent.get('/api/gardens');
    expect(gardens.body.data.map((g: { name: string }) => g.name)).toEqual(['Kept Garden']);
  });

  it('on a verified account: leaves the Terms and claimed_at untouched, and ignores choice', async () => {
    const id = await createUser({ termsVersion: TERMS_VERSION });
    const before = await termsRow();
    await resetPassword(id, 'not_mine');
    expect(cancelAndRefundUnused).not.toHaveBeenCalled();

    expect(await termsRow()).toEqual(before);
    expect(before.claimed_at).toBeNull();
    expect((await (await loginAgent('NewPassword1!')).get('/api/gardens')).status).toBe(200);
  });

  it("'not_mine' on an account verified after the page asked: a plain reset, reported as newAccount false", async () => {
    const id = await createUser({ verified: false, termsVersion: TERMS_VERSION });
    await insertResetToken(id);
    const inspect = await request(app).post('/api/auth/reset-password/inspect').send({ token: RESET_TOKEN });
    expect(inspect.body.data.unverifiedAccount).toBe(true);
    // Verified elsewhere before the person submits their "No".
    await pool.query('UPDATE accounts SET email_verified = true WHERE id = $1', [id]);

    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: RESET_TOKEN, password: 'NewPassword1!', choice: 'not_mine' });
    expect(res.status).toBe(200);
    expect(res.body.data.newAccount).toBe(false);
    expect(cancelAndRefundUnused).not.toHaveBeenCalled();
    const { rows } = await pool.query('SELECT id, displaced_at FROM accounts');
    expect(rows).toEqual([{ id, displaced_at: null }]);
    expect((await (await loginAgent('NewPassword1!')).get('/api/gardens')).status).toBe(200);
  });

  it("'mine' reports newAccount false", async () => {
    const unverified = await createUser({ verified: false });
    const mine = await postReset(unverified, 'mine');
    expect(mine.status).toBe(200);
    expect(mine.body.data.newAccount).toBe(false);
  });

  it('a plain reset of a verified account reports newAccount false', async () => {
    const verified = await createUser();
    const plain = await postReset(verified);
    expect(plain.status).toBe(200);
    expect(plain.body.data.newAccount).toBe(false);
  });
});

describe('POST /api/auth/reset-password/inspect', () => {
  it('reports whether the account is unverified without consuming the token', async () => {
    const id = await createUser({ verified: false });
    await insertResetToken(id);
    for (let i = 0; i < 2; i++) {
      const res = await request(app).post('/api/auth/reset-password/inspect').send({ token: RESET_TOKEN });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: { unverifiedAccount: true, email } });
    }
    expect(await resetTokenUsedAt(id)).toBeNull();

    await pool.query('UPDATE accounts SET email_verified = true WHERE id = $1', [id]);
    const verified = await request(app).post('/api/auth/reset-password/inspect').send({ token: RESET_TOKEN });
    expect(verified.body).toEqual({ data: { unverifiedAccount: false, email } });
  });

  it('rejects an unknown, missing or expired token', async () => {
    const id = await createUser({ verified: false });
    expect((await request(app).post('/api/auth/reset-password/inspect').send({ token: 'nope' })).status).toBe(400);
    expect((await request(app).post('/api/auth/reset-password/inspect').send({})).status).toBe(400);
    await insertResetToken(id, '-1 minute');
    const expired = await request(app).post('/api/auth/reset-password/inspect').send({ token: RESET_TOKEN });
    expect(expired.status).toBe(400);
    expect(expired.body).toEqual({ error: 'Invalid or expired reset token' });
  });
});

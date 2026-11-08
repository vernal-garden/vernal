import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import bcrypt from 'bcrypt';
import request from 'supertest';
import { Pool } from 'pg';
import type { Profile } from 'passport-google-oauth20';
import type { OAuthUser } from './providers/google';
import {
  resolveOAuthAccount,
  OAuthUnverifiedEmailError,
  OAuthLinkRequiresPasswordError,
  OAuthNotInvitedError,
  OAuthTakeoverChoiceRequired,
  OAuthTakeoverInvalidError,
  inspectOAuthTakeover,
  completeOAuthTakeover,
} from './resolveAccount';
import app from '../../index';
import { db } from '../db';
import { BETA_TERMS_VERSION, TERMS_VERSION } from '../legal';
import { invalidateBetaSettings } from '../beta';
import { cancelAndRefundUnused, forgetCustomerContact, liveSubscriptionIds } from '../billing';
import { hashToken } from '../tokens';
import { logger } from '../logger';
import * as mailer from '../mailer';

vi.mock('../mailer', () => ({ sendMail: vi.fn().mockResolvedValue(undefined) }));
const sendMailMock = vi.mocked(mailer.sendMail);
// The password-removed notices sent to an address.
const removedNotices = (to: string) =>
  sendMailMock.mock.calls.filter(([o]) => o.to === to && o.subject === 'Your Vernal password was removed');

// Stripe is never called: the displacement refund helper is a stand-in.
vi.mock('../billing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../billing')>()),
  cancelAndRefundUnused: vi.fn(),
  liveSubscriptionIds: vi.fn().mockResolvedValue([]),
  forgetCustomerContact: vi.fn(),
  expireOpenCheckoutSessions: vi.fn(),
}));

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

beforeEach(async () => {
  await resetDb();
  sendMailMock.mockReset().mockResolvedValue(undefined);
});
afterAll(async () => {
  await pool.end();
  await db.end();
});

describe('resolveOAuthAccount', () => {
  it('claims a verified password account on first link: password, tokens, sessions and both terms cleared', async () => {
    const id = await passwordAccount('linked@example.com', true);
    await pool.query(
      `UPDATE accounts SET pending_email = 'other@example.com', beta_terms_version = $2, beta_terms_accepted_at = now(),
                           terms_version = $3, terms_accepted_at = now()
        WHERE id = $1`,
      [id, BETA_TERMS_VERSION, TERMS_VERSION],
    );
    await pool.query(
      `INSERT INTO guest_sessions (token_hash, expires_at, account_id, migrated_at)
       VALUES ('squatter-session', now() + interval '1 day', $1, now())`,
      [id],
    );
    await pool.query(
      `INSERT INTO password_reset_tokens (account_id, token_hash, expires_at)
       VALUES ($1, 'h1', now() + interval '1 hour')`,
      [id],
    );
    await pool.query(
      `INSERT INTO email_change_tokens (account_id, token_hash, new_email, expires_at)
       VALUES ($1, 'h2', 'other@example.com', now() + interval '1 hour')`,
      [id],
    );
    await pool.query(
      `INSERT INTO email_verification_tokens (account_id, email, token_hash, expires_at)
       VALUES ($1, 'linked@example.com', 'h3', now() + interval '1 hour')`,
      [id],
    );

    const result = await resolveOAuthAccount(googleUser('g-1', 'Linked@Example.com', true, 'example.com'));
    expect(result).toEqual({ accountId: id, isNew: false });
    // The notice goes to the stored, lowercase address.
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(removedNotices('linked@example.com')).toHaveLength(1);

    const { rows } = await pool.query(
      `SELECT password_hash, email_verified, pending_email, beta_terms_version, beta_terms_accepted_at,
              terms_version, terms_accepted_at, claimed_at > now() - interval '1 minute' AS recently_claimed
         FROM accounts WHERE id = $1`,
      [id],
    );
    expect(rows[0]).toEqual({
      password_hash: null,
      email_verified: true,
      pending_email: null,
      beta_terms_version: null,
      beta_terms_accepted_at: null,
      terms_version: null,
      terms_accepted_at: null,
      recently_claimed: true,
    });
    expect((await pool.query('SELECT 1 FROM guest_sessions WHERE account_id = $1 AND expires_at > now()', [id])).rows).toHaveLength(0);
    expect((await pool.query('SELECT 1 FROM password_reset_tokens WHERE account_id = $1', [id])).rows).toHaveLength(0);
    expect((await pool.query('SELECT 1 FROM email_change_tokens WHERE account_id = $1', [id])).rows).toHaveLength(0);
    expect((await pool.query('SELECT 1 FROM email_verification_tokens WHERE account_id = $1', [id])).rows).toHaveLength(0);
    expect((await pool.query('SELECT 1 FROM oauth_identities WHERE account_id = $1', [id])).rows).toHaveLength(1);

    const login = await request(app).post('/api/auth/login').send({ email: 'linked@example.com', password: 'Password123!' });
    expect(login.status).toBe(401);
  });

  it('a second Google identity links to a verified account with no password, changing nothing', async () => {
    const first = await resolveOAuthAccount(googleUser('g-20', 'google-only@gmail.com'));
    const id = first.accountId;
    await pool.query(
      'UPDATE accounts SET beta_terms_version = $2, beta_terms_accepted_at = now() WHERE id = $1',
      [id, BETA_TERMS_VERSION],
    );
    await pool.query(
      `INSERT INTO guest_sessions (token_hash, expires_at, account_id, migrated_at)
       VALUES ('owner-session', now() + interval '1 day', $1, now())`,
      [id],
    );
    const before = (await pool.query('SELECT * FROM accounts WHERE id = $1', [id])).rows[0];

    expect(await resolveOAuthAccount(googleUser('g-21', 'google-only@gmail.com'))).toEqual({ accountId: id, isNew: false });

    expect((await pool.query('SELECT * FROM accounts WHERE id = $1', [id])).rows[0]).toEqual(before);
    expect((await pool.query('SELECT 1 FROM guest_sessions WHERE account_id = $1 AND expires_at > now()', [id])).rows).toHaveLength(1);
    expect((await pool.query('SELECT 1 FROM oauth_identities WHERE account_id = $1', [id])).rows).toHaveLength(2);
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

  it('records the accepted Terms version and time on a new account', async () => {
    const result = await resolveOAuthAccount(googleUser('g-6', 'terms@example.com'));
    const { rows } = await pool.query<{ terms_version: string | null; recent: boolean }>(
      `SELECT terms_version, terms_accepted_at > NOW() - INTERVAL '1 minute' AS recent
         FROM accounts WHERE id = $1`,
      [result.accountId],
    );
    expect(rows[0].terms_version).toBe(TERMS_VERSION);
    expect(rows[0].recent).toBe(true);
  });

  it('a plain link keeps the Terms acceptance and records no claim', async () => {
    const first = await resolveOAuthAccount(googleUser('g-8', 'kept-terms@gmail.com'));
    await resolveOAuthAccount(googleUser('g-9', 'kept-terms@gmail.com'));
    const { rows } = await pool.query<{ terms_version: string | null; claimed_at: Date | null }>(
      'SELECT terms_version, claimed_at FROM accounts WHERE id = $1',
      [first.accountId],
    );
    expect(rows[0]).toEqual({ terms_version: TERMS_VERSION, claimed_at: null });
  });

  it('returns the existing account for a known Google identity', async () => {
    const first = await resolveOAuthAccount(googleUser('g-5', 'repeat@example.com'));
    const second = await resolveOAuthAccount(googleUser('g-5', 'repeat@example.com'));
    expect(second).toEqual({ accountId: first.accountId, isNew: false });
  });
});

describe('resolveOAuthAccount — password-removed notice', () => {
  it('emails the owner once after claiming a verified account with a password', async () => {
    await passwordAccount('notice@gmail.com', true);
    await resolveOAuthAccount(googleUser('g-40', 'notice@gmail.com'));
    expect(removedNotices('notice@gmail.com')).toHaveLength(1);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
  });

  it('sends nothing for a Google-only account, a new account, or a known identity', async () => {
    const first = await resolveOAuthAccount(googleUser('g-41', 'only-google@gmail.com'));
    expect(first.isNew).toBe(true);
    await resolveOAuthAccount(googleUser('g-42', 'only-google@gmail.com'));
    await resolveOAuthAccount(googleUser('g-41', 'only-google@gmail.com'));
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it('a mail failure does not fail the sign-in, and the claim stays committed', async () => {
    const id = await passwordAccount('mail-down@gmail.com', true);
    sendMailMock.mockRejectedValueOnce(new Error('SMTP down'));
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    try {
      expect(await resolveOAuthAccount(googleUser('g-43', 'mail-down@gmail.com'))).toEqual({ accountId: id, isNew: false });
      expect(errorSpy).toHaveBeenCalledWith('Password-removed notice failed to send', expect.any(Error));
    } finally {
      errorSpy.mockRestore();
    }
    expect(removedNotices('mail-down@gmail.com')).toHaveLength(1);
    const { rows } = await pool.query('SELECT password_hash FROM accounts WHERE id = $1', [id]);
    expect(rows[0].password_hash).toBeNull();
  });

  it('sends only after the transaction has committed', async () => {
    const id = await passwordAccount('after-commit@gmail.com', true);
    let hashAtSend: unknown = 'not sent';
    sendMailMock.mockImplementationOnce(async () => {
      // A separate connection only sees committed data.
      hashAtSend = (await pool.query('SELECT password_hash FROM accounts WHERE id = $1', [id])).rows[0].password_hash;
    });
    await resolveOAuthAccount(googleUser('g-44', 'after-commit@gmail.com'));
    expect(hashAtSend).toBeNull();
  });
});

describe('resolveOAuthAccount — which addresses Google can vouch for', () => {
  it('accepts a gmail.com address for an existing account', async () => {
    const id = await passwordAccount('grower@gmail.com', true);
    expect(await resolveOAuthAccount(googleUser('g-10', 'grower@gmail.com'))).toEqual({ accountId: id, isNew: false });
  });

  it('accepts a googlemail.com address for an existing account', async () => {
    const id = await passwordAccount('grower@googlemail.com', true);
    expect(await resolveOAuthAccount(googleUser('g-11', 'grower@googlemail.com'))).toEqual({ accountId: id, isNew: false });
  });

  it('accepts a Workspace address whose hd matches the domain, case-insensitively', async () => {
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

describe('resolveOAuthAccount — an unverified account asks first', () => {
  const email = 'squatted@example.com';
  const owner = () => googleUser('g-30', email, true, 'example.com');

  async function setGate(on: boolean) {
    await pool.query('UPDATE beta_settings SET gate_on = $1, gate_first_on_at = NULL WHERE id = 1', [on]);
    invalidateBetaSettings();
  }

  beforeEach(async () => {
    await pool.query('DELETE FROM beta_invites');
    await setGate(false);
    vi.mocked(cancelAndRefundUnused).mockReset();
    vi.mocked(liveSubscriptionIds).mockReset().mockResolvedValue([]);
    vi.mocked(forgetCustomerContact).mockReset();
  });
  afterAll(async () => {
    await setGate(false);
  });

  // An unverified account with content, sessions, tokens and accepted terms.
  async function squatter(): Promise<number> {
    const id = await passwordAccount(email, false);
    await pool.query(
      `UPDATE accounts SET pending_email = 'other@example.com', terms_version = $2, terms_accepted_at = now(),
                           beta_participant_at = '2026-11-02T00:00:00Z'
        WHERE id = $1`,
      [id, TERMS_VERSION],
    );
    await pool.query(`INSERT INTO gardens (owner_id, name, style, zone) VALUES ($1, 'Old Garden', 'grid', '7a')`, [id]);
    await pool.query(
      `INSERT INTO guest_sessions (token_hash, expires_at, account_id, migrated_at)
       VALUES ('squatter-session', now() + interval '1 day', $1, now())`,
      [id],
    );
    await pool.query(
      `INSERT INTO password_reset_tokens (account_id, token_hash, expires_at) VALUES ($1, 'h1', now() + interval '1 hour')`,
      [id],
    );
    await pool.query(
      `INSERT INTO email_change_tokens (account_id, token_hash, new_email, expires_at)
       VALUES ($1, 'h2', 'other@example.com', now() + interval '1 hour')`,
      [id],
    );
    await pool.query(
      `INSERT INTO email_verification_tokens (account_id, email, token_hash, expires_at)
       VALUES ($1, $2, 'h3', now() + interval '1 hour')`,
      [id, email],
    );
    await pool.query(
      `INSERT INTO email_revert_tokens (account_id, token_hash, old_email, new_email, expires_at)
       VALUES ($1, 'h4', 'older@example.com', $2, now() + interval '1 hour')`,
      [id, email],
    );
    return id;
  }

  async function count(sql: string, id: number) {
    return (await pool.query(sql, [id])).rows.length;
  }

  // Every account row in id order, without updated_at.
  async function accountsSnapshot() {
    const { rows } = await pool.query('SELECT * FROM accounts ORDER BY id');
    return rows.map(({ updated_at: _updatedAt, ...rest }) => rest);
  }

  // The browser half of the latest held sign-in (the callback's cookie).
  let browser = '';

  // The callback's first step: the raw token of the held sign-in.
  async function holdSignIn(guestSessionId?: string): Promise<string> {
    const err = await resolveOAuthAccount(owner(), guestSessionId, '/garden').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuthTakeoverChoiceRequired);
    browser = (err as OAuthTakeoverChoiceRequired).browserToken;
    return (err as OAuthTakeoverChoiceRequired).token;
  }

  it('holds the sign-in as a pending takeover and changes nothing else', async () => {
    const oldId = await squatter();
    const before = await accountsSnapshot();

    const token = await holdSignIn();

    expect(await accountsSnapshot()).toEqual(before);
    expect((await pool.query('SELECT 1 FROM oauth_identities')).rows).toHaveLength(0);
    expect(await count('SELECT 1 FROM guest_sessions WHERE account_id = $1 AND expires_at > now()', oldId)).toBe(1);
    const { rows } = await pool.query(
      `SELECT token_hash, account_id, provider, provider_user_id, email, return_to, guest_session_id, browser_hash,
              access_token_encrypted IS NOT NULL AS has_access,
              expires_at BETWEEN now() + interval '14 minutes' AND now() + interval '16 minutes' AS fifteen_minutes
         FROM pending_takeovers`,
    );
    expect(rows).toEqual([
      {
        token_hash: hashToken(token),
        account_id: oldId,
        provider: 'google',
        provider_user_id: 'g-30',
        email,
        return_to: '/garden',
        guest_session_id: null,
        browser_hash: hashToken(browser),
        has_access: true,
        fifteen_minutes: true,
      },
    ]);
    expect(await inspectOAuthTakeover(token, browser)).toEqual({ email });
    expect(cancelAndRefundUnused).not.toHaveBeenCalled();
  });

  it("'mine' keeps the account and its data, verifies and claims it, and links the identity", async () => {
    const oldId = await squatter();
    const token = await holdSignIn();

    const result = await completeOAuthTakeover(token, browser, 'mine');
    expect(result).toEqual({ accountId: oldId, isNew: false, guestSessionId: null, returnTo: '/garden' });

    const { rows } = await pool.query(
      `SELECT email, password_hash, email_verified, pending_email, terms_version, terms_accepted_at,
              displaced_at, claimed_at > now() - interval '1 minute' AS recently_claimed
         FROM accounts WHERE id = $1`,
      [oldId],
    );
    expect(rows[0]).toEqual({
      email,
      password_hash: null,
      email_verified: true,
      pending_email: null,
      terms_version: null,
      terms_accepted_at: null,
      displaced_at: null,
      recently_claimed: true,
    });
    expect(await count('SELECT 1 FROM gardens WHERE owner_id = $1', oldId)).toBe(1);
    expect(await count('SELECT 1 FROM oauth_identities WHERE account_id = $1', oldId)).toBe(1);
    expect(await count('SELECT 1 FROM guest_sessions WHERE account_id = $1 AND expires_at > now()', oldId)).toBe(0);
    expect(await count('SELECT 1 FROM password_reset_tokens WHERE account_id = $1', oldId)).toBe(0);
    expect(await count('SELECT 1 FROM email_verification_tokens WHERE account_id = $1', oldId)).toBe(0);
    expect((await pool.query('SELECT 1 FROM pending_takeovers')).rows).toHaveLength(0);
    expect(cancelAndRefundUnused).not.toHaveBeenCalled();

    // Single use; afterwards the known identity signs straight in.
    await expect(completeOAuthTakeover(token, browser, 'mine')).rejects.toBeInstanceOf(OAuthTakeoverInvalidError);
    expect(await resolveOAuthAccount(owner())).toEqual({ accountId: oldId, isNew: false });
  });

  it("'not_mine' deletes the earlier account and gives the owner a new, empty account", async () => {
    const oldId = await squatter();
    const token = await holdSignIn();

    const result = await completeOAuthTakeover(token, browser, 'not_mine');
    expect(result.isNew).toBe(true);
    expect(result.accountId).not.toBe(oldId);

    const { rows: old } = await pool.query(
      `SELECT email, password_hash, pending_email, beta_participant_at,
              deletion_scheduled_at > now() - interval '1 minute' AS deleted,
              displaced_at > now() - interval '1 minute' AS displaced
         FROM accounts WHERE id = $1`,
      [oldId],
    );
    expect(old[0]).toEqual({
      email: `displaced-${oldId}@displaced.invalid`,
      password_hash: null,
      pending_email: null,
      beta_participant_at: new Date('2026-11-02T00:00:00Z'),
      deleted: true,
      displaced: true,
    });
    // Its content stays for the purge; nothing of it reaches the new account.
    expect(await count('SELECT 1 FROM gardens WHERE owner_id = $1', oldId)).toBe(1);
    expect(await count('SELECT 1 FROM guest_sessions WHERE account_id = $1 AND expires_at > now()', oldId)).toBe(0);
    expect(await count('SELECT 1 FROM password_reset_tokens WHERE account_id = $1', oldId)).toBe(0);
    expect(await count('SELECT 1 FROM email_change_tokens WHERE account_id = $1', oldId)).toBe(0);
    expect(await count('SELECT 1 FROM email_verification_tokens WHERE account_id = $1', oldId)).toBe(0);
    expect(await count('SELECT 1 FROM email_revert_tokens WHERE account_id = $1', oldId)).toBe(0);
    expect(await count('SELECT 1 FROM oauth_identities WHERE account_id = $1', oldId)).toBe(0);

    const { rows: fresh } = await pool.query(
      `SELECT email, email_verified, password_hash, terms_version, claimed_at, beta_participant_at,
              terms_accepted_at > now() - interval '1 minute' AS terms_recent
         FROM accounts WHERE id = $1`,
      [result.accountId],
    );
    expect(fresh[0]).toEqual({
      email,
      email_verified: true,
      password_hash: null,
      terms_version: TERMS_VERSION,
      claimed_at: null,
      beta_participant_at: null,
      terms_recent: true,
    });
    expect(await count('SELECT 1 FROM gardens WHERE owner_id = $1', result.accountId)).toBe(0);
    expect(await count('SELECT 1 FROM oauth_identities WHERE account_id = $1', result.accountId)).toBe(1);

    // Signing in again with Google lands on the new account.
    expect(await resolveOAuthAccount(owner())).toEqual({ accountId: result.accountId, isNew: false });
    const login = await request(app).post('/api/auth/login').send({ email, password: 'Password123!' });
    expect(login.status).toBe(401);
    expect(cancelAndRefundUnused).not.toHaveBeenCalled();
  });

  it("'not_mine' cancels and refunds every live subscription first, and clears the Stripe customer's contact after", async () => {
    const oldId = await squatter();
    await pool.query(
      `UPDATE accounts SET stripe_customer_id = 'cus_1', stripe_subscription_id = 'sub_1' WHERE id = $1`,
      [oldId],
    );
    vi.mocked(liveSubscriptionIds).mockResolvedValue(['sub_2']);
    const token = await holdSignIn();
    expect(cancelAndRefundUnused).not.toHaveBeenCalled();

    const result = await completeOAuthTakeover(token, browser, 'not_mine');
    expect(vi.mocked(cancelAndRefundUnused).mock.calls).toEqual([
      ['sub_1', oldId],
      ['sub_2', oldId],
    ]);
    expect(forgetCustomerContact).toHaveBeenCalledWith('cus_1', oldId);

    const { rows } = await pool.query(
      'SELECT stripe_customer_id FROM accounts WHERE id = ANY($1::int[]) ORDER BY id',
      [[oldId, result.accountId]],
    );
    expect(rows.map((r) => r.stripe_customer_id)).toEqual(['cus_1', null]);
  });

  it('flags a lifetime purchase for a manual refund review once, after the displacement commits', async () => {
    const oldId = await squatter();
    await pool.query(`UPDATE accounts SET stripe_lifetime_payment_intent = 'pi_1' WHERE id = $1`, [oldId]);
    const token = await holdSignIn();
    const order: string[] = [];
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation((msg) => void order.push(msg));
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation((msg) => void order.push(msg));
    try {
      const result = await completeOAuthTakeover(token, browser, 'not_mine');
      expect(result.isNew).toBe(true);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(
        `Lifetime purchase on displaced account ${oldId} needs a manual refund review`,
        undefined,
        { accountId: oldId, paymentIntent: 'pi_1' },
      );
      expect(order).toEqual([
        'Account displaced by the address owner',
        `Lifetime purchase on displaced account ${oldId} needs a manual refund review`,
      ]);
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
    expect(cancelAndRefundUnused).not.toHaveBeenCalled();
  });

  it('billing settled but the account verified meanwhile: no displacement, no lifetime alert, an operator alert', async () => {
    const oldId = await squatter();
    await pool.query(
      `UPDATE accounts SET stripe_customer_id = 'cus_1', stripe_lifetime_payment_intent = 'pi_1' WHERE id = $1`,
      [oldId],
    );
    const token = await holdSignIn();
    // The account is verified while Stripe is being settled.
    vi.mocked(liveSubscriptionIds).mockImplementation(async () => {
      await pool.query('UPDATE accounts SET email_verified = true WHERE id = $1', [oldId]);
      return [];
    });
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    try {
      // Now verified: the normal claim rules apply (claimed in place, no displacement).
      const result = await completeOAuthTakeover(token, browser, 'not_mine');
      expect(result).toMatchObject({ accountId: oldId, isNew: false });
      expect(errorSpy).toHaveBeenCalledWith('Displacement billing settled but account not displaced', undefined, {
        accountId: oldId,
      });
      expect(errorSpy.mock.calls.some(([msg]) => /needs a manual refund review/.test(String(msg)))).toBe(false);
    } finally {
      errorSpy.mockRestore();
    }
    expect(forgetCustomerContact).not.toHaveBeenCalled();
    const { rows } = await pool.query('SELECT displaced_at FROM accounts WHERE id = $1', [oldId]);
    expect(rows[0].displaced_at).toBeNull();
    // Claimed in place with its password removed: one notice.
    expect(removedNotices(email)).toHaveLength(1);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
  });

  it("a Stripe failure on 'not_mine' refuses, changes nothing, and the token stays usable", async () => {
    const oldId = await squatter();
    await pool.query(`UPDATE accounts SET stripe_subscription_id = 'sub_1' WHERE id = $1`, [oldId]);
    const token = await holdSignIn();
    vi.mocked(cancelAndRefundUnused).mockRejectedValueOnce(new Error('stripe down'));
    const before = await accountsSnapshot();

    await expect(completeOAuthTakeover(token, browser, 'not_mine')).rejects.toThrow('stripe down');

    expect(await accountsSnapshot()).toEqual(before);
    expect(await count('SELECT 1 FROM guest_sessions WHERE account_id = $1 AND expires_at > now()', oldId)).toBe(1);
    expect((await pool.query('SELECT 1 FROM oauth_identities')).rows).toHaveLength(0);
    expect(await inspectOAuthTakeover(token, browser)).toEqual({ email });
  });

  it("under the invite gate an uninvited owner answering 'not_mine' is refused and the earlier account is untouched", async () => {
    await squatter();
    await pool.query(`UPDATE accounts SET stripe_subscription_id = 'sub_1'`);
    await setGate(true);
    const token = await holdSignIn();
    const before = await accountsSnapshot();

    await expect(completeOAuthTakeover(token, browser, 'not_mine')).rejects.toBeInstanceOf(OAuthNotInvitedError);

    expect(await accountsSnapshot()).toEqual(before);
    expect((await pool.query('SELECT 1 FROM oauth_identities')).rows).toHaveLength(0);
    expect(cancelAndRefundUnused).not.toHaveBeenCalled();
  });

  it("under the invite gate an invited owner answering 'not_mine' gets a new participant account", async () => {
    const oldId = await squatter();
    await pool.query('INSERT INTO beta_invites (email) VALUES ($1)', [email]);
    await setGate(true);
    const token = await holdSignIn();

    const result = await completeOAuthTakeover(token, browser, 'not_mine');
    expect(result.accountId).not.toBe(oldId);
    const { rows } = await pool.query<{
      beta_participant_at: Date | null;
      beta_joined_via: string | null;
      beta_terms_version: string | null;
    }>('SELECT beta_participant_at, beta_joined_via, beta_terms_version FROM accounts WHERE id = $1', [
      result.accountId,
    ]);
    expect(rows[0].beta_participant_at).not.toBeNull();
    expect(rows[0].beta_joined_via).toBe('invite');
    expect(rows[0].beta_terms_version).toBeNull();
  });

  it('an expired or unknown token is refused', async () => {
    await squatter();
    const token = await holdSignIn();
    await pool.query("UPDATE pending_takeovers SET expires_at = now() - interval '1 second'");
    expect(await inspectOAuthTakeover(token, browser)).toBeNull();
    await expect(completeOAuthTakeover(token, browser, 'mine')).rejects.toBeInstanceOf(OAuthTakeoverInvalidError);
    await expect(completeOAuthTakeover('unknown', browser, 'not_mine')).rejects.toBeInstanceOf(OAuthTakeoverInvalidError);
    expect(cancelAndRefundUnused).not.toHaveBeenCalled();
  });

  it('only completes with the browser half from the callback', async () => {
    await squatter();
    const token = await holdSignIn();
    const before = await accountsSnapshot();
    for (const other of [null, '', 'f'.repeat(64)]) {
      expect(await inspectOAuthTakeover(token, other)).toBeNull();
      await expect(completeOAuthTakeover(token, other, 'not_mine')).rejects.toBeInstanceOf(OAuthTakeoverInvalidError);
    }
    // A row held by the previous release has no browser half and can't complete.
    await pool.query('UPDATE pending_takeovers SET browser_hash = NULL');
    await expect(completeOAuthTakeover(token, browser, 'mine')).rejects.toBeInstanceOf(OAuthTakeoverInvalidError);
    expect(await accountsSnapshot()).toEqual(before);
    expect(cancelAndRefundUnused).not.toHaveBeenCalled();
  });

  it("'not_mine' with under 2 minutes left is refused before Stripe is touched", async () => {
    const oldId = await squatter();
    await pool.query(`UPDATE accounts SET stripe_subscription_id = 'sub_1' WHERE id = $1`, [oldId]);
    const token = await holdSignIn();
    await pool.query("UPDATE pending_takeovers SET expires_at = now() + interval '90 seconds'");
    const before = await accountsSnapshot();
    await expect(completeOAuthTakeover(token, browser, 'not_mine')).rejects.toBeInstanceOf(OAuthTakeoverInvalidError);
    expect(cancelAndRefundUnused).not.toHaveBeenCalled();
    expect(await accountsSnapshot()).toEqual(before);
    // 'mine' touches no billing and still completes.
    expect((await completeOAuthTakeover(token, browser, 'mine')).accountId).toBe(oldId);
  });

  it("'mine' on an account with a password emails the owner once; holding the sign-in sends nothing", async () => {
    await squatter();
    const token = await holdSignIn();
    expect(sendMailMock).not.toHaveBeenCalled();
    await completeOAuthTakeover(token, browser, 'mine');
    expect(removedNotices(email)).toHaveLength(1);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
  });

  it("'mine' sends the notice only after the transaction has committed", async () => {
    const oldId = await squatter();
    const token = await holdSignIn();
    let hashAtSend: unknown = 'not sent';
    sendMailMock.mockImplementationOnce(async () => {
      // A separate connection only sees committed data.
      hashAtSend = (await pool.query('SELECT password_hash FROM accounts WHERE id = $1', [oldId])).rows[0].password_hash;
    });
    await completeOAuthTakeover(token, browser, 'mine');
    expect(hashAtSend).toBeNull();
  });

  it("'mine' on an account with no password sends nothing", async () => {
    const oldId = await squatter();
    await pool.query('UPDATE accounts SET password_hash = NULL WHERE id = $1', [oldId]);
    const token = await holdSignIn();
    const result = await completeOAuthTakeover(token, browser, 'mine');
    expect(result.accountId).toBe(oldId);
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("'not_mine' sends no password-removed notice", async () => {
    await squatter();
    const token = await holdSignIn();
    const result = await completeOAuthTakeover(token, browser, 'not_mine');
    expect(result.isNew).toBe(true);
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("a mail failure on 'mine' does not fail the sign-in", async () => {
    const oldId = await squatter();
    const token = await holdSignIn();
    sendMailMock.mockRejectedValueOnce(new Error('SMTP down'));
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    try {
      const result = await completeOAuthTakeover(token, browser, 'mine');
      expect(result).toEqual({ accountId: oldId, isNew: false, guestSessionId: null, returnTo: '/garden' });
      expect(errorSpy).toHaveBeenCalledWith('Password-removed notice failed to send', expect.any(Error));
    } finally {
      errorSpy.mockRestore();
    }
    expect(removedNotices(email)).toHaveLength(1);
  });

  it('billing settled but a racing request displaced the account: a warning, not an operator alert', async () => {
    const oldId = await squatter();
    const token = await holdSignIn();
    // Another request displaces the account while Stripe is being settled.
    vi.mocked(liveSubscriptionIds).mockImplementation(async () => []);
    vi.mocked(cancelAndRefundUnused).mockImplementation(async () => {
      await pool.query(
        `UPDATE accounts SET email = 'displaced-' || id || '@displaced.invalid', displaced_at = now() WHERE id = $1`,
        [oldId],
      );
    });
    await pool.query(`UPDATE accounts SET stripe_subscription_id = 'sub_1' WHERE id = $1`, [oldId]);
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    try {
      await completeOAuthTakeover(token, browser, 'not_mine').catch(() => undefined);
      expect(warnSpy).toHaveBeenCalledWith('Displacement billing settled; account already displaced by another request', {
        accountId: oldId,
      });
      expect(errorSpy.mock.calls.some(([msg]) => msg === 'Displacement billing settled but account not displaced')).toBe(
        false,
      );
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { Pool } from 'pg';
import passport from 'passport';
import type { Profile } from 'passport-google-oauth20';
import app from '../index';
import { invalidateBetaSettings } from '../lib/beta';
import { BETA_TERMS_VERSION, TERMS_VERSION } from '../lib/legal';
import { resolveOAuthAccount, OAuthNotInvitedError } from '../lib/oauth/resolveAccount';
import type { OAuthUser } from '../lib/oauth/providers/google';
import { db } from '../lib/db';
import { hashToken } from '../lib/tokens';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL must be set to run tests');

const pool = new Pool({ connectionString: url });

const GARDEN = { name: 'Guest Garden', style: 'grid', zone: '6b', growingMethod: 'raised_bed' };
const PASSWORD = 'Password123!';

async function resetBeta() {
  await pool.query('DELETE FROM beta_invites');
  await pool.query(
    `UPDATE beta_settings
        SET gate_on = false, guest_mode_on = true, supporter_access_on = true,
            gate_first_on_at = NULL
      WHERE id = 1`,
  );
  invalidateBetaSettings();
}

async function setGate(on: boolean, firstOnAt: string | null = null) {
  await pool.query('UPDATE beta_settings SET gate_on = $1, gate_first_on_at = $2 WHERE id = 1', [on, firstOnAt]);
  invalidateBetaSettings();
}

async function invite(email: string) {
  await pool.query('INSERT INTO beta_invites (email) VALUES ($1)', [email]);
}

async function accountRow(email: string) {
  const { rows } = await pool.query(
    `SELECT id, beta_participant_at, beta_joined_via, beta_terms_version, beta_terms_accepted_at
       FROM accounts WHERE email = $1`,
    [email],
  );
  return rows[0] as
    | {
        id: number;
        beta_participant_at: Date | null;
        beta_joined_via: 'invite' | 'guest' | null;
        beta_terms_version: string | null;
        beta_terms_accepted_at: Date | null;
      }
    | undefined;
}

async function guestAgentWithGarden() {
  const agent = request.agent(app);
  await agent.post('/api/auth/guest').expect(201);
  const garden = await agent.post('/api/gardens').send(GARDEN);
  expect(garden.status).toBe(201);
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM guest_sessions WHERE account_id IS NULL ORDER BY created_at DESC LIMIT 1',
  );
  return { agent, sessionId: rows[0].id, gardenId: garden.body.id as string };
}

async function gardenOwnerCount(sessionId: string) {
  const { rows } = await pool.query('SELECT 1 FROM gardens WHERE guest_session_id = $1', [sessionId]);
  return rows.length;
}

// Guest created before the gate first went on, open at that moment.
async function backdateGuest(sessionId: string, firstOnAt: string) {
  await pool.query(
    `UPDATE guest_sessions
        SET created_at = $2::timestamptz - interval '1 day',
            expires_at = $2::timestamptz + interval '1 day'
      WHERE id = $1`,
    [sessionId, firstOnAt],
  );
}

// Created before switch-on and still open now (and so open at switch-on too).
async function makeGuestLive(agent: request.Agent, sessionId: string, firstOnAt: string) {
  await pool.query(
    `UPDATE guest_sessions
        SET created_at = $2::timestamptz - interval '1 day',
            expires_at = now() + interval '1 day'
      WHERE id = $1`,
    [sessionId, firstOnAt],
  );
  const session = await agent.get('/api/auth/session');
  expect(session.body.data.isGuest).toBe(true);
}

const FIRST_ON = '2026-11-01T00:00:00Z';

beforeEach(async () => {
  await pool.query('TRUNCATE accounts, guest_sessions, oauth_identities RESTART IDENTITY CASCADE');
});
afterEach(resetBeta);
afterAll(async () => {
  await pool.end();
  await db.end();
});

describe('POST /api/auth/register, invite gate', () => {
  const email = 'newbie@example.com';
  const register = (agent: { post: (u: string) => request.Test }, body: Record<string, unknown> = {}) =>
    agent.post('/api/auth/register').send({ email, password: PASSWORD, ...body });

  it('gate on, not invited: 403 not_invited, nothing created', async () => {
    await setGate(true, FIRST_ON);
    const res = await register(request(app));
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "That email address isn't on the invite list.", code: 'not_invited' });
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(await accountRow(email)).toBeUndefined();
    expect(await identityCount(email)).toBe(0);
  });

  it('gate on, not invited, with a guest session: guest data untouched', async () => {
    await setGate(true, FIRST_ON);
    const { agent, sessionId } = await guestAgentWithGarden();
    // Created after switch-on: does not qualify.
    const res = await register(agent);
    expect(res.status).toBe(403);
    expect(await accountRow(email)).toBeUndefined();
    expect(await gardenOwnerCount(sessionId)).toBe(1);
    const { rows } = await pool.query('SELECT account_id, migrated_at FROM guest_sessions WHERE id = $1', [sessionId]);
    expect(rows[0].account_id).toBeNull();
    expect(rows[0].migrated_at).toBeNull();
  });

  it('gate on, invited, accepting the terms: participant with both acceptance columns', async () => {
    await setGate(true, FIRST_ON);
    await invite(email);
    const res = await register(request(app), { acceptBetaTerms: true });
    expect(res.status).toBe(201);
    const row = (await accountRow(email))!;
    expect(row.beta_participant_at).not.toBeNull();
    expect(row.beta_joined_via).toBe('invite');
    expect(row.beta_terms_version).toBe(BETA_TERMS_VERSION);
    expect(row.beta_terms_accepted_at).not.toBeNull();
  });

  it('gate on, invited, no acceptBetaTerms: 400 beta_terms_required, nothing created', async () => {
    await setGate(true, FIRST_ON);
    await invite(email);
    const { agent, sessionId } = await guestAgentWithGarden();
    const res = await register(agent);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Accept the beta terms to continue.', code: 'beta_terms_required' });
    expect(await accountRow(email)).toBeUndefined();
    expect(await gardenOwnerCount(sessionId)).toBe(1);
    const again = await register(agent, { acceptBetaTerms: false });
    expect(again.status).toBe(400);
  });

  it('gate off, invited: participant; without acceptance it is pending', async () => {
    await invite(email);
    const res = await register(request(app));
    expect(res.status).toBe(201);
    const row = (await accountRow(email))!;
    expect(row.beta_participant_at).not.toBeNull();
    expect(row.beta_joined_via).toBe('invite');
    expect(row.beta_terms_version).toBeNull();
    expect(row.beta_terms_accepted_at).toBeNull();
  });

  it('gate off, invited, accepting: acceptance recorded', async () => {
    await invite(email);
    expect((await register(request(app), { acceptBetaTerms: true })).status).toBe(201);
    const row = (await accountRow(email))!;
    expect(row.beta_participant_at).not.toBeNull();
    expect(row.beta_joined_via).toBe('invite');
    expect(row.beta_terms_version).toBe(BETA_TERMS_VERSION);
    expect(row.beta_terms_accepted_at).not.toBeNull();
  });

  it('gate off, not invited: created without beta fields, acceptBetaTerms ignored', async () => {
    const res = await register(request(app), { acceptBetaTerms: true });
    expect(res.status).toBe(201);
    const row = (await accountRow(email))!;
    expect(row.beta_participant_at).toBeNull();
    expect(row.beta_joined_via).toBeNull();
    expect(row.beta_terms_version).toBeNull();
    expect(row.beta_terms_accepted_at).toBeNull();
  });

  it('invite match is case-insensitive on the typed email', async () => {
    await setGate(true, FIRST_ON);
    await invite(email);
    const res = await register(request(app), { email: 'NewBie@Example.com', acceptBetaTerms: true });
    expect(res.status).toBe(201);
  });

  it('gate on, qualifying live guest session: created as participant, garden migrated', async () => {
    await setGate(true, FIRST_ON);
    const { agent, sessionId } = await guestAgentWithGarden();
    await makeGuestLive(agent, sessionId, FIRST_ON);
    const res = await register(agent, { acceptBetaTerms: true });
    expect(res.status).toBe(201);
    const row = (await accountRow(email))!;
    expect(row.beta_participant_at).not.toBeNull();
    expect(row.beta_joined_via).toBe('guest');
    expect(row.beta_terms_version).toBe(BETA_TERMS_VERSION);
    const { rows } = await pool.query('SELECT 1 FROM gardens WHERE owner_id = $1', [row.id]);
    expect(rows).toHaveLength(1);
  });

  it('gate on, invited and a qualifying live guest session: joined via invite', async () => {
    await setGate(true, FIRST_ON);
    await invite(email);
    const { agent, sessionId } = await guestAgentWithGarden();
    await makeGuestLive(agent, sessionId, FIRST_ON);
    expect((await register(agent, { acceptBetaTerms: true })).status).toBe(201);
    const row = (await accountRow(email))!;
    expect(row.beta_participant_at).not.toBeNull();
    expect(row.beta_joined_via).toBe('invite');
  });

  it('gate on, qualifying guest but no acceptBetaTerms: 400, garden stays with the guest', async () => {
    await setGate(true, FIRST_ON);
    const { agent, sessionId } = await guestAgentWithGarden();
    await makeGuestLive(agent, sessionId, FIRST_ON);
    const res = await register(agent);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('beta_terms_required');
    expect(await gardenOwnerCount(sessionId)).toBe(1);
  });

  it('gate on, expired-but-unmigrated guest session that was open at switch-on: created, garden migrated', async () => {
    await setGate(true, FIRST_ON);
    const { agent, sessionId } = await guestAgentWithGarden();
    await backdateGuest(sessionId, FIRST_ON);
    // Expired now (so findSession finds no live session), but open at switch-on.
    await pool.query("UPDATE guest_sessions SET expires_at = now() - interval '1 hour' WHERE id = $1", [sessionId]);
    const res = await register(agent, { acceptBetaTerms: true });
    expect(res.status).toBe(201);
    const row = (await accountRow(email))!;
    expect(row.beta_participant_at).not.toBeNull();
    expect(row.beta_joined_via).toBe('guest');
    const { rows } = await pool.query('SELECT 1 FROM gardens WHERE owner_id = $1', [row.id]);
    expect(rows).toHaveLength(1);
  });

  it('gate on, expired-but-unmigrated guest session already expired at switch-on: refused', async () => {
    await setGate(true, FIRST_ON);
    const { agent, sessionId } = await guestAgentWithGarden();
    await pool.query(
      `UPDATE guest_sessions
          SET created_at = $2::timestamptz - interval '10 days',
              expires_at = $2::timestamptz - interval '1 day'
        WHERE id = $1`,
      [sessionId, FIRST_ON],
    );
    const res = await register(agent, { acceptBetaTerms: true });
    expect(res.status).toBe(403);
    expect(await accountRow(email)).toBeUndefined();
    expect(await gardenOwnerCount(sessionId)).toBe(1);
  });

  it('gate on, guest session created after switch-on: refused', async () => {
    await setGate(true, '2020-01-01T00:00:00Z');
    const { agent } = await guestAgentWithGarden();
    const res = await register(agent, { acceptBetaTerms: true });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('not_invited');
  });

  it("gate on: an existing account's email still gets 409, not 403", async () => {
    await setGate(true, FIRST_ON);
    const hash = await bcrypt.hash(PASSWORD, 4);
    await pool.query(
      `INSERT INTO accounts (email, password_hash, zone, zone_location_label, email_verified)
       VALUES ($1, $2, '7b', 'Test City', true)`,
      [email, hash],
    );
    const res = await register(request(app));
    expect(res.status).toBe(409);
  });

  it('gate on: signing in to an existing account whose email is not invited works', async () => {
    const hash = await bcrypt.hash(PASSWORD, 4);
    await pool.query(
      `INSERT INTO accounts (email, password_hash, zone, zone_location_label, email_verified)
       VALUES ($1, $2, '7b', 'Test City', true)`,
      [email, hash],
    );
    await setGate(true, FIRST_ON);
    const res = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
    expect(res.status).toBe(200);
  });

  it('a refusal releases its connection: repeated refusals do not exhaust the pool', async () => {
    await setGate(true, FIRST_ON);
    for (let i = 0; i < 25; i++) {
      expect((await register(request(app))).status).toBe(403);
    }
    await setGate(false);
    expect((await register(request(app))).status).toBe(201);
  }, 30_000);
});

function googleUser(id: string, email: string): OAuthUser {
  return {
    provider: 'google',
    accessToken: 'access',
    refreshToken: undefined,
    profile: {
      id,
      provider: 'google',
      displayName: 'Gardener',
      emails: [{ value: email, verified: true }],
      photos: [],
      _json: {},
    } as unknown as Profile,
  };
}

async function identityCount(email: string) {
  const { rows } = await pool.query('SELECT 1 FROM oauth_identities WHERE email = $1', [email]);
  return rows.length;
}

describe('resolveOAuthAccount, invite gate', () => {
  const email = 'oauth-new@gmail.com';

  it('gate on, not invited: OAuthNotInvitedError, no account, no identity, guest data untouched', async () => {
    await setGate(true, '2020-01-01T00:00:00Z');
    const { sessionId } = await guestAgentWithGarden();
    await expect(resolveOAuthAccount(googleUser('g-1', email), sessionId)).rejects.toBeInstanceOf(OAuthNotInvitedError);
    expect(await accountRow(email)).toBeUndefined();
    expect(await identityCount(email)).toBe(0);
    expect(await gardenOwnerCount(sessionId)).toBe(1);
  });

  it('gate on, invited: created with beta_participant_at, terms pending', async () => {
    await setGate(true, FIRST_ON);
    await invite(email);
    const result = await resolveOAuthAccount(googleUser('g-2', email));
    expect(result.isNew).toBe(true);
    const row = (await accountRow(email))!;
    expect(row.beta_participant_at).not.toBeNull();
    expect(row.beta_joined_via).toBe('invite');
    expect(row.beta_terms_version).toBeNull();
    expect(row.beta_terms_accepted_at).toBeNull();
    expect(await identityCount(email)).toBe(1);
  });

  it('gate off, invited: created with beta_participant_at', async () => {
    await invite(email);
    await resolveOAuthAccount(googleUser('g-3', email));
    const row = (await accountRow(email))!;
    expect(row.beta_participant_at).not.toBeNull();
    expect(row.beta_joined_via).toBe('invite');
  });

  it('gate off, not invited: created without it', async () => {
    await resolveOAuthAccount(googleUser('g-4', email));
    const row = (await accountRow(email))!;
    expect(row.beta_participant_at).toBeNull();
    expect(row.beta_joined_via).toBeNull();
  });

  it('gate on, qualifying guest session: created as participant, garden migrated', async () => {
    await setGate(true, FIRST_ON);
    const { agent, sessionId } = await guestAgentWithGarden();
    await makeGuestLive(agent, sessionId, FIRST_ON);
    const result = await resolveOAuthAccount(googleUser('g-5', email), sessionId);
    expect(result.isNew).toBe(true);
    const row = (await accountRow(email))!;
    expect(row.beta_participant_at).not.toBeNull();
    expect(row.beta_joined_via).toBe('guest');
    const { rows } = await pool.query('SELECT 1 FROM gardens WHERE owner_id = $1', [row.id]);
    expect(rows).toHaveLength(1);
  });

  it('gate on, invited and a qualifying guest session: joined via invite', async () => {
    await setGate(true, FIRST_ON);
    await invite(email);
    const { agent, sessionId } = await guestAgentWithGarden();
    await makeGuestLive(agent, sessionId, FIRST_ON);
    await resolveOAuthAccount(googleUser('g-5b', email), sessionId);
    const row = (await accountRow(email))!;
    expect(row.beta_participant_at).not.toBeNull();
    expect(row.beta_joined_via).toBe('invite');
  });

  it('gate on, guest session created after switch-on: refused', async () => {
    await setGate(true, '2020-01-01T00:00:00Z');
    const { sessionId } = await guestAgentWithGarden();
    await expect(resolveOAuthAccount(googleUser('g-6', email), sessionId)).rejects.toBeInstanceOf(OAuthNotInvitedError);
    expect(await accountRow(email)).toBeUndefined();
  });

  it('gate on: a known identity signs in though the email is not invited', async () => {
    const first = await resolveOAuthAccount(googleUser('g-7', email));
    await setGate(true, FIRST_ON);
    const again = await resolveOAuthAccount(googleUser('g-7', email));
    expect(again).toEqual({ accountId: first.accountId, isNew: false });
  });

  it('gate on: an existing account with that email links though not invited', async () => {
    const hash = await bcrypt.hash(PASSWORD, 4);
    await pool.query(
      `INSERT INTO accounts (email, password_hash, zone, zone_location_label, email_verified)
       VALUES ($1, $2, '7b', 'Test City', true)`,
      [email, hash],
    );
    await setGate(true, FIRST_ON);
    const result = await resolveOAuthAccount(googleUser('g-8', email));
    expect(result.isNew).toBe(false);
    expect(await identityCount(email)).toBe(1);
  });
});

describe('Google callback, not invited', () => {
  const state = (nonce: string) => Buffer.from(JSON.stringify({ nonce, returnTo: '/' })).toString('base64url');

  it('redirects to /private-beta?refused=1 and sets no session cookie', async () => {
    const email = 'callback-new@gmail.com';
    await setGate(true, FIRST_ON);
    const oauthUser = googleUser('g-cb', email);
    // Stand-in for the Google strategy, as in authSecurity.test.ts.
    const registry = passport as unknown as { _strategy(name: string): passport.Strategy };
    const google = registry._strategy('google');
    passport.use('google', {
      name: 'google',
      authenticate(this: { success(user: unknown): void }) {
        this.success(oauthUser);
      },
    } as unknown as passport.Strategy);
    try {
      const nonce = 'e'.repeat(32);
      const res = await request(app)
        .get(`/api/auth/oauth/google/callback?code=abc&state=${state(nonce)}`)
        .set('Cookie', [`_vernal_oauth_nonce=${nonce}`]);
      expect(res.status).toBe(302);
      expect(res.headers.location).toMatch(/\/private-beta\?refused=1$/);
      expect(((res.headers['set-cookie'] as unknown as string[] | undefined) ?? []).some((c) => c.startsWith('_vernal_sid='))).toBe(false);
    } finally {
      passport.use('google', google);
    }
    expect(await accountRow(email)).toBeUndefined();
    expect(await identityCount(email)).toBe(0);
  });
});

describe('claiming an account, beta terms acceptance', () => {
  const email = 'claimed@gmail.com';
  const state = (nonce: string) => Buffer.from(JSON.stringify({ nonce, returnTo: '/' })).toString('base64url');

  async function acceptedParticipant(verified: boolean) {
    const hash = await bcrypt.hash(PASSWORD, 4);
    await pool.query(
      `INSERT INTO accounts
         (email, password_hash, zone, zone_location_label, email_verified,
          beta_participant_at, beta_terms_version, beta_terms_accepted_at)
       VALUES ($1, $2, '7b', 'Test City', $3, '2026-11-02T00:00:00Z', $4, '2026-11-03T00:00:00Z')`,
      [email, hash, verified, BETA_TERMS_VERSION],
    );
    return (await accountRow(email))!;
  }

  // The Google callback with a stand-in strategy, as in authSecurity.test.ts.
  async function claimViaGoogle() {
    const oauthUser = googleUser('g-claim', email);
    const registry = passport as unknown as { _strategy(name: string): passport.Strategy };
    const google = registry._strategy('google');
    passport.use('google', {
      name: 'google',
      authenticate(this: { success(user: unknown): void }) {
        this.success(oauthUser);
      },
    } as unknown as passport.Strategy);
    try {
      const nonce = 'f'.repeat(32);
      const res = await request(app)
        .get(`/api/auth/oauth/google/callback?code=abc&state=${state(nonce)}`)
        .set('Cookie', [`_vernal_oauth_nonce=${nonce}`]);
      expect(res.status).toBe(302);
      return { location: res.headers.location as string, cookies: res.headers['set-cookie'] as unknown as string[] };
    } finally {
      passport.use('google', google);
    }
  }

  async function resetPassword(accountId: number, choice?: 'mine' | 'not_mine') {
    const token = 'claim-reset-token';
    await pool.query(
      `INSERT INTO password_reset_tokens (account_id, token_hash, expires_at)
       VALUES ($1, $2, now() + interval '1 hour')`,
      [accountId, hashToken(token)],
    );
    const res = await request(app).post('/api/auth/reset-password').send({ token, password: 'NewPassword1!', choice });
    expect(res.status).toBe(200);
  }

  async function loginWithNewPassword() {
    const agent = request.agent(app);
    await agent.post('/api/auth/guest');
    const res = await agent.post('/api/auth/login').send({ email, password: 'NewPassword1!' });
    expect(res.status).toBe(200);
    return agent;
  }

  it("a Google sign-in on an unverified participant answered 'not_mine' gives the owner a new account; the date stays with the old one", async () => {
    const before = await acceptedParticipant(false);
    await invite(email);
    const { location, cookies: callbackCookies } = await claimViaGoogle();
    const token = new URL(location).searchParams.get('token')!;
    expect(location).toMatch(/\/claim-account\?token=[a-f0-9]{64}$/);
    // The takeover only completes in the browser the callback came back to.
    const takeoverCookie = callbackCookies.find((c) => c.startsWith('_vernal_takeover='))!.split(';')[0];
    const answer = await request(app)
      .post('/api/auth/takeover')
      .set('Cookie', takeoverCookie)
      .send({ token, choice: 'not_mine' });
    expect(answer.status).toBe(200);
    const cookies = answer.headers['set-cookie'] as unknown as string[];

    const { rows: old } = await pool.query('SELECT beta_participant_at, displaced_at FROM accounts WHERE id = $1', [before.id]);
    expect(old[0].beta_participant_at).toEqual(before.beta_participant_at);
    expect(old[0].displaced_at).not.toBeNull();

    // The new account is a participant through its invite, with beta terms still to accept.
    const row = (await accountRow(email))!;
    expect(row.id).not.toBe(before.id);
    expect(row.beta_participant_at).not.toBeNull();
    expect(row.beta_joined_via).toBe('invite');
    expect(row.beta_terms_version).toBeNull();
    const held = await request(app).get('/api/gardens').set('Cookie', cookies);
    expect(held.status).toBe(403);
    expect(held.body.code).toBe('beta_terms_required');
  });

  it('a Google claim of a verified account with a password clears the acceptance and the session is held', async () => {
    const before = await acceptedParticipant(true);
    const { location, cookies } = await claimViaGoogle();
    expect(location).toMatch(/\/$/);

    const row = (await accountRow(email))!;
    expect(row.beta_terms_version).toBeNull();
    expect(row.beta_terms_accepted_at).toBeNull();
    expect(row.beta_participant_at).toEqual(before.beta_participant_at);
    expect(row.beta_joined_via).toBe(before.beta_joined_via);

    const gardens = await request(app).get('/api/gardens').set('Cookie', cookies);
    expect(gardens.status).toBe(403);
    expect(gardens.body.code).toBe('terms_required');
  });

  it('a reset on an unverified participant gives the owner a new account held at both terms', async () => {
    const before = await acceptedParticipant(false);
    await invite(email);
    await resetPassword(before.id, 'not_mine');

    const { rows: old } = await pool.query('SELECT beta_participant_at FROM accounts WHERE id = $1', [before.id]);
    expect(old[0].beta_participant_at).toEqual(before.beta_participant_at);
    const row = (await accountRow(email))!;
    expect(row.id).not.toBe(before.id);
    expect(row.beta_participant_at).not.toBeNull();
    expect(row.beta_joined_via).toBe('invite');
    expect(row.beta_terms_version).toBeNull();

    const agent = await loginWithNewPassword();
    const gardens = await agent.get('/api/gardens');
    expect(gardens.status).toBe(403);
    expect(gardens.body.code).toBe('terms_required');
    expect((await agent.post('/api/me/terms').send({ accept: true, version: TERMS_VERSION })).status).toBe(204);
    expect((await agent.get('/api/gardens')).body.code).toBe('beta_terms_required');
  });

  it('a reset on an unverified account that is not invited gives a non-participant account', async () => {
    const before = await acceptedParticipant(false);
    await resetPassword(before.id, 'not_mine');
    const row = (await accountRow(email))!;
    expect(row.id).not.toBe(before.id);
    expect(row.beta_participant_at).toBeNull();
    expect(row.beta_joined_via).toBeNull();
  });

  it('a reset on a verified account keeps the acceptance', async () => {
    const before = await acceptedParticipant(true);
    await resetPassword(before.id);

    expect(await accountRow(email)).toEqual(before);
    expect((await (await loginWithNewPassword()).get('/api/gardens')).status).toBe(200);
  });
});

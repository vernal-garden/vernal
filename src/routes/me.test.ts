import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { Pool } from 'pg';
import app from '../index';
import * as mailer from '../lib/mailer';
import * as exportWorker from '../lib/exportWorker';

vi.mock('../lib/mailer', () => ({ sendMail: vi.fn().mockResolvedValue(undefined) }));
const sendMailMock = vi.mocked(mailer.sendMail);

vi.mock('../lib/exportWorker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/exportWorker')>()),
  processExportJob: vi.fn().mockResolvedValue(undefined),
}));
const processExportJobMock = vi.mocked(exportWorker.processExportJob);

function extractToken(html: string): string {
  const match = html.match(/token=([a-f0-9]+)/);
  if (!match) throw new Error('No token found in mailer call');
  return match[1];
}

async function createOAuthUser(email: string): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO accounts (email, password_hash, zone, zone_location_label, email_verified)
     VALUES ($1, NULL, '7b', 'Test City', true)
     RETURNING id`,
    [email],
  );
  return rows[0].id;
}

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL must be set to run tests');

const pool = new Pool({ connectionString: url });

async function resetDb() {
  await pool.query(
    'TRUNCATE accounts, guest_sessions, password_reset_tokens RESTART IDENTITY CASCADE',
  );
}

async function createUser(
  email: string,
  password: string | null = 'Password123!',
): Promise<number> {
  const hash = password ? await bcrypt.hash(password, 4) : null;
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO accounts
       (email, password_hash, zone, zone_location_label, email_verified)
     VALUES ($1, $2, '7b', 'Test City', true)
     RETURNING id`,
    [email, hash],
  );
  return rows[0].id;
}

async function loginAgent(email: string, password = 'Password123!') {
  const agent = request.agent(app);
  await agent.post('/api/auth/guest');
  await agent.post('/api/auth/login').send({ email, password });
  return agent;
}

beforeAll(resetDb);
afterAll(() => pool.end());

// ── Test 1: GET / ─────────────────────────────────────────────────────────────

describe('GET /api/me', () => {
  let agent: ReturnType<typeof request.agent>;

  beforeAll(async () => {
    await createUser('me-get@example.com');
    agent = await loginAgent('me-get@example.com');
  });

  it('returns full profile with expected fields', async () => {
    const res = await agent.get('/api/me');
    expect(res.status).toBe(200);
    const p = res.body.data;
    expect(p.email).toBe('me-get@example.com');
    expect(p.zone).toBe('7b');
    expect(p.zoneLocationLabel).toBe('Test City');
    expect(p.lastSpringFrostDate).toBeNull();
    expect(p.firstFallFrostDate).toBeNull();
    expect(p.preferences).toEqual({});
    expect(p.deletionScheduledAt).toBeNull();
    expect(p.emailVerified).toBe(true);
    expect(p.createdAt).toBeDefined();
    expect(p.updatedAt).toBeDefined();
  });

  it('returns 401 with no session', async () => {
    const res = await request(app).get('/api/me');
    expect(res.status).toBe(401);
  });

  it('includes supporterPromptShown: false on a fresh account', async () => {
    const res = await agent.get('/api/me');
    expect(res.status).toBe(200);
    expect(res.body.data.supporterPromptShown).toBe(false);
  });

  it('includes pendingEmail: null on a fresh account', async () => {
    const res = await agent.get('/api/me');
    expect(res.status).toBe(200);
    expect(res.body.data.pendingEmail).toBeNull();
  });
});

// ── Test 2: PATCH / — displayName validation ──────────────────────────────────

describe('PATCH /api/me — displayName', () => {
  let agent: ReturnType<typeof request.agent>;

  beforeAll(async () => {
    await createUser('me-displayname@example.com');
    agent = await loginAgent('me-displayname@example.com');
  });

  it('accepts a displayName of exactly 60 characters', async () => {
    const res = await agent.patch('/api/me').send({ displayName: 'A'.repeat(60) });
    expect(res.status).toBe(200);
    expect(res.body.data.displayName).toBe('A'.repeat(60));
  });

  it('rejects displayName of 61 characters', async () => {
    const res = await agent.patch('/api/me').send({ displayName: 'A'.repeat(61) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/displayName/);
  });

  it('rejects blank displayName', async () => {
    const res = await agent.patch('/api/me').send({ displayName: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/displayName/);
  });
});

// ── Test 3: PATCH / — zone and zoneLocationLabel ──────────────────────────────

describe('PATCH /api/me — zone', () => {
  let agent: ReturnType<typeof request.agent>;

  beforeAll(async () => {
    await createUser('me-zone@example.com');
    agent = await loginAgent('me-zone@example.com');
  });

  it('rejects blank zone', async () => {
    const res = await agent.patch('/api/me').send({ zone: '' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/zone/);
  });

  it('accepts a new zone and zoneLocationLabel and echoes them back', async () => {
    const res = await agent
      .patch('/api/me')
      .send({ zone: '8a', zoneLocationLabel: 'Seattle, WA' });
    expect(res.status).toBe(200);
    expect(res.body.data.zone).toBe('8a');
    expect(res.body.data.zoneLocationLabel).toBe('Seattle, WA');
  });
});

// ── Test 4: PATCH / — frost dates ─────────────────────────────────────────────

describe('PATCH /api/me — frost dates', () => {
  let agent: ReturnType<typeof request.agent>;

  beforeAll(async () => {
    await createUser('me-frost@example.com');
    agent = await loginAgent('me-frost@example.com');
  });

  it('accepts YYYY-MM-DD for lastSpringFrostDate', async () => {
    const res = await agent.patch('/api/me').send({ lastSpringFrostDate: '2026-04-15' });
    expect(res.status).toBe(200);
    expect(res.body.data.lastSpringFrostDate).toBe('2026-04-15');
  });

  it('clears lastSpringFrostDate when null is sent', async () => {
    const res = await agent.patch('/api/me').send({ lastSpringFrostDate: null });
    expect(res.status).toBe(200);
    expect(res.body.data.lastSpringFrostDate).toBeNull();
  });

  it('rejects MM/DD/YYYY format', async () => {
    const res = await agent.patch('/api/me').send({ lastSpringFrostDate: '04/15/2026' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/lastSpringFrostDate/);
  });
});

// ── Test 5: PATCH / — forbidden fields ───────────────────────────────────────

describe('PATCH /api/me — forbidden fields', () => {
  let agent: ReturnType<typeof request.agent>;

  beforeAll(async () => {
    await createUser('me-forbidden@example.com');
    agent = await loginAgent('me-forbidden@example.com');
  });

  it('rejects onboardingCompletedAt with 400', async () => {
    const res = await agent
      .patch('/api/me')
      .send({ onboardingCompletedAt: '2026-01-01T00:00:00Z' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/onboardingCompletedAt/);
  });

  it('rejects email with 400', async () => {
    const res = await agent.patch('/api/me').send({ email: 'new@example.com' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/email/);
  });
});

// ── Test 6: PATCH / — empty body ──────────────────────────────────────────────

describe('PATCH /api/me — empty body', () => {
  let agent: ReturnType<typeof request.agent>;

  beforeAll(async () => {
    await createUser('me-empty@example.com');
    agent = await loginAgent('me-empty@example.com');
  });

  it('returns 400 when body has no updatable fields', async () => {
    const res = await agent.patch('/api/me').send({});
    expect(res.status).toBe(400);
  });
});

// ── Test 7: PATCH /preferences ────────────────────────────────────────────────

describe('PATCH /api/me/preferences', () => {
  let agent: ReturnType<typeof request.agent>;

  beforeAll(async () => {
    await createUser('me-prefs@example.com');
    agent = await loginAgent('me-prefs@example.com');
  });

  it('sets {theme: dark}', async () => {
    const res = await agent.patch('/api/me/preferences').send({ theme: 'dark' });
    expect(res.status).toBe(200);
    expect(res.body.data.preferences.theme).toBe('dark');
  });

  it('merges {lang: en} — both theme and lang are present', async () => {
    const res = await agent.patch('/api/me/preferences').send({ lang: 'en' });
    expect(res.status).toBe(200);
    expect(res.body.data.preferences.theme).toBe('dark');
    expect(res.body.data.preferences.lang).toBe('en');
  });

  it('removes a key when its value is null', async () => {
    const res = await agent.patch('/api/me/preferences').send({ theme: null });
    expect(res.status).toBe(200);
    expect(res.body.data.preferences).not.toHaveProperty('theme');
    expect(res.body.data.preferences.lang).toBe('en');
  });

  it('rejects an array body with 400', async () => {
    const res = await agent.patch('/api/me/preferences').send([{ theme: 'light' }]);
    expect(res.status).toBe(400);
  });
});

// ── Tests 8-9: PATCH /password ────────────────────────────────────────────────

// NOTE: Tests in this block are intentionally sequential — the first it() changes
// the password from 'OldPass1!' to 'NewPass2@', and subsequent tests depend on
// that change. Do not run individual tests in isolation or reorder them.
describe('PATCH /api/me/password', () => {
  let agent: ReturnType<typeof request.agent>;
  let agent2: ReturnType<typeof request.agent>;

  beforeAll(async () => {
    await createUser('me-pw@example.com', 'OldPass1!');
    agent = await loginAgent('me-pw@example.com', 'OldPass1!');
    // Second independent session for the same account
    agent2 = await loginAgent('me-pw@example.com', 'OldPass1!');
  });

  it('changes password with correct current password', async () => {
    const res = await agent
      .patch('/api/me/password')
      .send({ currentPassword: 'OldPass1!', newPassword: 'NewPass2@' });
    expect(res.status).toBe(200);
    expect(res.body.data.message).toMatch(/updated/i);
  });

  it('can log in with the new password after change', async () => {
    const freshAgent = request.agent(app);
    await freshAgent.post('/api/auth/guest');
    const login = await freshAgent
      .post('/api/auth/login')
      .send({ email: 'me-pw@example.com', password: 'NewPass2@' });
    expect(login.status).toBe(200);
  });

  it('the changing session still authenticates after the change', async () => {
    const res = await agent.get('/api/me');
    expect(res.status).toBe(200);
  });

  it('a pre-existing second session gets 401 after the password change', async () => {
    const res = await agent2.get('/api/me');
    expect(res.status).toBe(401);
  });

  it('rejects wrong current password with 400', async () => {
    const a = await loginAgent('me-pw@example.com', 'NewPass2@');
    const res = await a
      .patch('/api/me/password')
      .send({ currentPassword: 'WrongPass!', newPassword: 'AnotherPass3#' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/incorrect/i);
  });

  it('rejects password change on OAuth-only account with 400 mentioning OAuth', async () => {
    // Create an account with null password_hash (OAuth-only)
    const { rows: [acct] } = await pool.query<{ id: number }>(
      `INSERT INTO accounts (email, password_hash, zone, zone_location_label, email_verified)
       VALUES ('me-oauth@example.com', NULL, '7b', 'Test City', true)
       RETURNING id`,
    );
    // Create a session directly via SQL, then compute the HMAC signature for the cookie
    const crypto = await import('crypto');
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await pool.query(
      `INSERT INTO guest_sessions (token, expires_at, account_id, migrated_at)
       VALUES ($1, $2, $3, now())`,
      [token, expiresAt, acct.id],
    );
    const secret = process.env.SESSION_SECRET!;
    const sig = crypto.createHmac('sha256', secret).update(token).digest('hex');
    const signedToken = `${token}.${sig}`;

    const res = await request(app)
      .patch('/api/me/password')
      .set('Cookie', `_vernal_sid=${encodeURIComponent(signedToken)}`)
      .send({ currentPassword: 'anything', newPassword: 'anything123' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/oauth/i);
  });
});

// ── Tests 10-11: DELETE / ─────────────────────────────────────────────────────

describe('DELETE /api/me', () => {
  let agent: ReturnType<typeof request.agent>;
  let accountId: number;
  let firstDeletionTimestamp: string;

  beforeAll(async () => {
    accountId = await createUser('me-delete@example.com');
    agent = await loginAgent('me-delete@example.com');
  });

  it('returns 204 and sets deletion_scheduled_at (test 10)', async () => {
    const res = await agent.delete('/api/me');
    expect(res.status).toBe(204);

    const { rows } = await pool.query<{ deletion_scheduled_at: Date }>(
      'SELECT deletion_scheduled_at FROM accounts WHERE id = $1',
      [accountId],
    );
    expect(rows[0].deletion_scheduled_at).not.toBeNull();
    firstDeletionTimestamp = rows[0].deletion_scheduled_at.toISOString();
  });

  it('old session cookie no longer authenticates after DELETE', async () => {
    const res = await agent.get('/api/me');
    expect(res.status).toBe(401);
  });

  it('re-login succeeds and GET /session shows deletionScheduledAt', async () => {
    const freshAgent = await loginAgent('me-delete@example.com');
    const sessionRes = await freshAgent.get('/api/auth/session');
    expect(sessionRes.status).toBe(200);
    expect(sessionRes.body.data.account.deletionScheduledAt).not.toBeNull();

    // Test 11: a second DELETE does not reset the original timestamp
    const del2 = await freshAgent.delete('/api/me');
    expect(del2.status).toBe(204);

    const { rows } = await pool.query<{ deletion_scheduled_at: Date }>(
      'SELECT deletion_scheduled_at FROM accounts WHERE id = $1',
      [accountId],
    );
    expect(rows[0].deletion_scheduled_at.toISOString()).toBe(firstDeletionTimestamp);
  });
});

// ── Test 12: POST /cancel-deletion ────────────────────────────────────────────

describe('POST /api/me/cancel-deletion', () => {
  let agent: ReturnType<typeof request.agent>;
  let accountId: number;

  beforeAll(async () => {
    accountId = await createUser('me-cancel@example.com');
    // Schedule deletion first
    await pool.query(
      `UPDATE accounts SET deletion_scheduled_at = NOW() WHERE id = $1`,
      [accountId],
    );
    agent = await loginAgent('me-cancel@example.com');
  });

  it('cancels deletion and returns { deletionScheduledAt: null }', async () => {
    const res = await agent.post('/api/me/cancel-deletion');
    expect(res.status).toBe(200);
    expect(res.body.data.deletionScheduledAt).toBeNull();

    const { rows } = await pool.query(
      'SELECT deletion_scheduled_at FROM accounts WHERE id = $1',
      [accountId],
    );
    expect(rows[0].deletion_scheduled_at).toBeNull();
  });

  it('is idempotent — calling again returns 200 with null', async () => {
    const res = await agent.post('/api/me/cancel-deletion');
    expect(res.status).toBe(200);
    expect(res.body.data.deletionScheduledAt).toBeNull();
  });
});

// ── Test 12.5: POST /supporter-prompt/shown ──────────────────────────────────

describe('POST /api/me/supporter-prompt/shown', () => {
  let agent: ReturnType<typeof request.agent>;
  let accountId: number;

  beforeAll(async () => {
    accountId = await createUser('me-supporter-prompt@example.com');
    agent = await loginAgent('me-supporter-prompt@example.com');
  });

  it('sets supporter_prompt_shown to true', async () => {
    const res = await agent.post('/api/me/supporter-prompt/shown');
    expect(res.status).toBe(200);
    expect(res.body.data.supporterPromptShown).toBe(true);

    const { rows } = await pool.query<{ supporter_prompt_shown: boolean }>(
      'SELECT supporter_prompt_shown FROM accounts WHERE id = $1',
      [accountId],
    );
    expect(rows[0].supporter_prompt_shown).toBe(true);
  });

  it('is idempotent — calling again still returns 200 with true', async () => {
    const res = await agent.post('/api/me/supporter-prompt/shown');
    expect(res.status).toBe(200);
    expect(res.body.data.supporterPromptShown).toBe(true);
  });

  it('returns 401 with no session', async () => {
    const res = await request(app).post('/api/me/supporter-prompt/shown');
    expect(res.status).toBe(401);
  });
});

// ── Test 13: All routes require authentication ─────────────────────────────────

describe('All /api/me routes require a session', () => {
  const unauthed = () => request(app);

  it('GET / returns 401', async () => {
    expect((await unauthed().get('/api/me')).status).toBe(401);
  });

  it('PATCH / returns 401', async () => {
    expect((await unauthed().patch('/api/me').send({ displayName: 'x' })).status).toBe(401);
  });

  it('PATCH /preferences returns 401', async () => {
    expect((await unauthed().patch('/api/me/preferences').send({ x: 1 })).status).toBe(401);
  });

  it('PATCH /password returns 401', async () => {
    expect(
      (
        await unauthed()
          .patch('/api/me/password')
          .send({ currentPassword: 'a', newPassword: 'b' })
      ).status,
    ).toBe(401);
  });

  it('DELETE / returns 401', async () => {
    expect((await unauthed().delete('/api/me')).status).toBe(401);
  });

  it('POST /cancel-deletion returns 401', async () => {
    expect((await unauthed().post('/api/me/cancel-deletion')).status).toBe(401);
  });
});

// ── Tests 14-24: Email change flow ───────────────────────────────────────────

describe('PATCH /api/me/email', () => {
  let agent: ReturnType<typeof request.agent>;
  let accountId: number;

  beforeAll(async () => {
    accountId = await createUser('me-email-change@example.com');
    agent = await loginAgent('me-email-change@example.com');
  });

  it('sets pending_email, sends a confirmation email, and returns pendingEmail (test 14)', async () => {
    sendMailMock.mockClear();
    const res = await agent
      .patch('/api/me/email')
      .send({ newEmail: 'new-address@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.data.pendingEmail).toBe('new-address@example.com');

    const { rows } = await pool.query<{ pending_email: string | null }>(
      'SELECT pending_email FROM accounts WHERE id = $1',
      [accountId],
    );
    expect(rows[0].pending_email).toBe('new-address@example.com');

    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(sendMailMock.mock.calls[0][0].to).toBe('new-address@example.com');
  });

  it('rejects the same email as the current one with 400 (test 15)', async () => {
    const res = await agent
      .patch('/api/me/email')
      .send({ newEmail: 'me-email-change@example.com' });
    expect(res.status).toBe(400);
  });

  it('rejects an email already in use with 409 (test 16)', async () => {
    await createUser('me-email-taken@example.com');
    const res = await agent.patch('/api/me/email').send({ newEmail: 'me-email-taken@example.com' });
    expect(res.status).toBe(409);
  });

  it('rejects email change for OAuth accounts with 400 (test 17)', async () => {
    const oauthId = await createOAuthUser('me-email-oauth@example.com');
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await pool.query(
      `INSERT INTO guest_sessions (token, expires_at, account_id, migrated_at) VALUES ($1, $2, $3, now())`,
      [token, expiresAt, oauthId],
    );
    const secret = process.env.SESSION_SECRET!;
    const sig = crypto.createHmac('sha256', secret).update(token).digest('hex');
    const signedToken = `${token}.${sig}`;

    const res = await request(app)
      .patch('/api/me/email')
      .set('Cookie', `_vernal_sid=${encodeURIComponent(signedToken)}`)
      .send({ newEmail: 'wont-work@example.com' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/oauth/i);
  });

  it('replaces an existing unused token on a second request (test 18)', async () => {
    const first = await pool.query<{ id: number; token_hash: string }>(
      'SELECT id, token_hash FROM email_change_tokens WHERE account_id = $1 AND used_at IS NULL',
      [accountId],
    );
    expect(first.rows).toHaveLength(1);

    const res = await agent
      .patch('/api/me/email')
      .send({ newEmail: 'second-address@example.com' });
    expect(res.status).toBe(200);

    const second = await pool.query<{ id: number; token_hash: string }>(
      'SELECT id, token_hash FROM email_change_tokens WHERE account_id = $1 AND used_at IS NULL',
      [accountId],
    );
    expect(second.rows).toHaveLength(1);
    expect(second.rows[0].id).not.toBe(first.rows[0].id);
    expect(second.rows[0].token_hash).not.toBe(first.rows[0].token_hash);
  });
});

describe('DELETE /api/me/email', () => {
  let agent: ReturnType<typeof request.agent>;
  let accountId: number;

  beforeAll(async () => {
    accountId = await createUser('me-email-cancel@example.com');
    agent = await loginAgent('me-email-cancel@example.com');
    await agent.patch('/api/me/email').send({ newEmail: 'cancel-target@example.com' });
  });

  it('clears pending_email and deletes the unused token (test 19)', async () => {
    const res = await agent.delete('/api/me/email');
    expect(res.status).toBe(200);
    expect(res.body.data.pendingEmail).toBeNull();

    const { rows } = await pool.query<{ pending_email: string | null }>(
      'SELECT pending_email FROM accounts WHERE id = $1',
      [accountId],
    );
    expect(rows[0].pending_email).toBeNull();

    const tokens = await pool.query(
      'SELECT id FROM email_change_tokens WHERE account_id = $1 AND used_at IS NULL',
      [accountId],
    );
    expect(tokens.rows).toHaveLength(0);
  });
});

describe('GET /api/me/email/confirm', () => {
  let agent: ReturnType<typeof request.agent>;

  beforeAll(async () => {
    await createUser('me-email-confirm@example.com');
    agent = await loginAgent('me-email-confirm@example.com');
  });

  it('confirms a valid token: updates email, marks token used, clears pending_email (test 20)', async () => {
    sendMailMock.mockClear();
    const patchRes = await agent
      .patch('/api/me/email')
      .send({ newEmail: 'confirmed-address@example.com' });
    expect(patchRes.status).toBe(200);
    const rawToken = extractToken(sendMailMock.mock.calls[0][0].html);

    const res = await agent.get(`/api/me/email/confirm?token=${rawToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.email).toBe('confirmed-address@example.com');

    const meRes = await agent.get('/api/me');
    expect(meRes.body.data.email).toBe('confirmed-address@example.com');
    expect(meRes.body.data.pendingEmail).toBeNull();

    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const { rows } = await pool.query<{ used_at: Date | null }>(
      'SELECT used_at FROM email_change_tokens WHERE token_hash = $1',
      [tokenHash],
    );
    expect(rows[0].used_at).not.toBeNull();
  });

  it('rejects an expired token with 400 (test 21)', async () => {
    const accountId = await createUser('me-email-expired@example.com');
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    await pool.query(
      `INSERT INTO email_change_tokens (account_id, token_hash, new_email, expires_at)
       VALUES ($1, $2, 'expired-target@example.com', NOW() - INTERVAL '1 hour')`,
      [accountId, tokenHash],
    );

    const res = await agent.get(`/api/me/email/confirm?token=${rawToken}`);
    expect(res.status).toBe(400);
  });

  it('rejects an already-used token with 400 (test 22)', async () => {
    const accountId = await createUser('me-email-used@example.com');
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    await pool.query(
      `INSERT INTO email_change_tokens (account_id, token_hash, new_email, expires_at, used_at)
       VALUES ($1, $2, 'used-target@example.com', NOW() + INTERVAL '1 hour', NOW())`,
      [accountId, tokenHash],
    );

    const res = await agent.get(`/api/me/email/confirm?token=${rawToken}`);
    expect(res.status).toBe(400);
  });

  it('rejects with 409 when the new email was taken before confirmation (test 23)', async () => {
    const raceAgentEmail = 'me-email-race@example.com';
    const raceAccountId = await createUser(raceAgentEmail);
    const raceAgent = await loginAgent(raceAgentEmail);

    const patchRes = await raceAgent
      .patch('/api/me/email')
      .send({ newEmail: 'raced-address@example.com' });
    expect(patchRes.status).toBe(200);
    const rawToken = extractToken(
      sendMailMock.mock.calls[sendMailMock.mock.calls.length - 1][0].html,
    );

    // Simulate another account taking the target address before confirmation.
    const otherAccountId = await createUser('me-email-race-other@example.com');
    await pool.query('UPDATE accounts SET email = $1 WHERE id = $2', [
      'raced-address@example.com',
      otherAccountId,
    ]);

    const res = await raceAgent.get(`/api/me/email/confirm?token=${rawToken}`);
    expect(res.status).toBe(409);

    // The original account's email must remain unchanged.
    const { rows } = await pool.query<{ email: string }>(
      'SELECT email FROM accounts WHERE id = $1',
      [raceAccountId],
    );
    expect(rows[0].email).toBe(raceAgentEmail);
  });

  it('returns 400 when token is missing', async () => {
    const res = await agent.get('/api/me/email/confirm');
    expect(res.status).toBe(400);
  });
});

// ── Data export ───────────────────────────────────────────────────────────────

describe('/api/me/export', () => {
  let agent: ReturnType<typeof request.agent>;
  let accountId: number;

  async function insertJob(
    status: string,
    opts: { expiresInDays?: number; downloadUrl?: string; requestedMinutesAgo?: number } = {},
  ): Promise<number> {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO data_export_jobs (account_id, status, requested_at, download_url, expires_at)
       VALUES ($1, $2, NOW() - ($3::text || ' minutes')::interval, $4,
               CASE WHEN $5::int IS NULL THEN NULL ELSE NOW() + ($5::text || ' days')::interval END)
       RETURNING id`,
      [
        accountId,
        status,
        opts.requestedMinutesAgo ?? 0,
        opts.downloadUrl ?? null,
        opts.expiresInDays ?? null,
      ],
    );
    return rows[0].id;
  }

  beforeAll(async () => {
    accountId = await createUser('me-export@example.com');
    agent = await loginAgent('me-export@example.com');
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM data_export_jobs WHERE account_id = $1', [accountId]);
    processExportJobMock.mockClear();
  });

  it('POST inserts a pending job and returns 202 with its id', async () => {
    const res = await agent.post('/api/me/export');
    expect(res.status).toBe(202);
    expect(res.body.data.status).toBe('pending');
    expect(typeof res.body.data.jobId).toBe('number');

    const { rows } = await pool.query(
      'SELECT account_id, status FROM data_export_jobs WHERE id = $1',
      [res.body.data.jobId],
    );
    expect(rows[0]).toEqual({ account_id: accountId, status: 'pending' });
    expect(processExportJobMock).toHaveBeenCalledWith(res.body.data.jobId);
  });

  it('POST returns 409 while a job is pending', async () => {
    await insertJob('pending');
    const res = await agent.post('/api/me/export');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('An export is already in progress.');
    expect(processExportJobMock).not.toHaveBeenCalled();
  });

  it('POST returns 409 while a job is processing', async () => {
    await insertJob('processing');
    const res = await agent.post('/api/me/export');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('An export is already in progress.');
  });

  it('POST returns the existing download for an unexpired complete job', async () => {
    await insertJob('complete', { expiresInDays: 3, downloadUrl: 'https://r2.example.com/x.zip' });
    const res = await agent.post('/api/me/export');
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('complete');
    expect(res.body.data.downloadUrl).toBe('https://r2.example.com/x.zip');
    expect(res.body.data.expiresAt).toBeTruthy();
    expect(processExportJobMock).not.toHaveBeenCalled();

    const { rows } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM data_export_jobs WHERE account_id = $1',
      [accountId],
    );
    expect(rows[0].n).toBe(1);
  });

  it('POST creates a new job once the complete job has expired', async () => {
    const oldId = await insertJob('complete', {
      expiresInDays: -1,
      downloadUrl: 'https://r2.example.com/old.zip',
    });
    const res = await agent.post('/api/me/export');
    expect(res.status).toBe(202);
    expect(res.body.data.jobId).not.toBe(oldId);
    expect(processExportJobMock).toHaveBeenCalledWith(res.body.data.jobId);
  });

  it('GET returns 404 when no export was requested', async () => {
    const res = await agent.get('/api/me/export');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('No export requested.');
  });

  it('GET returns the latest job', async () => {
    await insertJob('failed', { requestedMinutesAgo: 60 });
    const latestId = await insertJob('complete', {
      expiresInDays: 7,
      downloadUrl: 'https://r2.example.com/new.zip',
    });

    const res = await agent.get('/api/me/export');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      jobId: latestId,
      status: 'complete',
      downloadUrl: 'https://r2.example.com/new.zip',
      expired: false,
    });
    expect(res.body.data.requestedAt).toBeTruthy();
    expect(res.body.data.expiresAt).toBeTruthy();
  });

  it('GET marks a complete job past expires_at as expired with no download URL', async () => {
    await insertJob('complete', { expiresInDays: -1, downloadUrl: 'https://r2.example.com/old.zip' });
    const res = await agent.get('/api/me/export');
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('complete');
    expect(res.body.data.expired).toBe(true);
    expect(res.body.data.downloadUrl).toBeNull();
  });

  async function jobStatus(id: number): Promise<string> {
    const { rows } = await pool.query<{ status: string }>(
      'SELECT status FROM data_export_jobs WHERE id = $1',
      [id],
    );
    return rows[0].status;
  }

  it.each(['processing', 'pending'])(
    'POST fails a %s job older than 15 minutes and queues a new one',
    async (status) => {
      const staleId = await insertJob(status, { requestedMinutesAgo: 16 });

      const res = await agent.post('/api/me/export');
      expect(res.status).toBe(202);
      expect(res.body.data.jobId).not.toBe(staleId);

      expect(await jobStatus(staleId)).toBe('failed');
      expect(await jobStatus(res.body.data.jobId)).toBe('pending');
    },
  );

  it('POST still returns 409 for a processing job younger than 15 minutes', async () => {
    const jobId = await insertJob('processing', { requestedMinutesAgo: 14 });

    const res = await agent.post('/api/me/export');
    expect(res.status).toBe(409);
    expect(await jobStatus(jobId)).toBe('processing');
  });

  it('GET reports a stale processing job as failed', async () => {
    const jobId = await insertJob('processing', { requestedMinutesAgo: 16 });

    const res = await agent.get('/api/me/export');
    expect(res.status).toBe(200);
    expect(res.body.data.jobId).toBe(jobId);
    expect(res.body.data.status).toBe('failed');
  });

  it("does not touch another account's stale job", async () => {
    const otherId = await createUser('me-export-other@example.com');
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO data_export_jobs (account_id, status, requested_at)
       VALUES ($1, 'processing', NOW() - INTERVAL '16 minutes')
       RETURNING id`,
      [otherId],
    );
    const otherJobId = rows[0].id;

    expect((await agent.get('/api/me/export')).status).toBe(404);
    expect((await agent.post('/api/me/export')).status).toBe(202);
    expect(await jobStatus(otherJobId)).toBe('processing');

    await pool.query('DELETE FROM accounts WHERE id = $1', [otherId]);
  });

  it('requires an account session', async () => {
    const guest = request.agent(app);
    await guest.post('/api/auth/guest');
    expect((await guest.post('/api/me/export')).status).toBe(401);
    expect((await guest.get('/api/me/export')).status).toBe(401);
  });
});

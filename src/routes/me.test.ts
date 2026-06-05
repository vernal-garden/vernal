import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { Pool } from 'pg';
import app from '../index';

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

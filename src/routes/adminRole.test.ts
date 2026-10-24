import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { Pool } from 'pg';
import app from '../index';
import { hashToken } from '../lib/tokens';
import { COOKIE_NAME } from '../lib/sessions';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL must be set to run tests');

const pool = new Pool({ connectionString: url });

const PASSWORD = 'Password123!';

async function resetDb() {
  await pool.query(
    'TRUNCATE accounts, guest_sessions, password_reset_tokens, admin_audit_log RESTART IDENTITY CASCADE',
  );
}

async function createUser(email: string, role: 'user' | 'admin' = 'user'): Promise<number> {
  const hash = await bcrypt.hash(PASSWORD, 4);
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO accounts
       (email, password_hash, zone, zone_location_label, email_verified, role)
     VALUES ($1, $2, '7b', 'Test City', true, $3)
     RETURNING id`,
    [email, hash, role],
  );
  return Number(rows[0].id);
}

async function loginAgent(email: string) {
  const agent = request.agent(app);
  await agent.post('/api/auth/guest');
  await agent.post('/api/auth/login').send({ email, password: PASSWORD });
  return agent;
}

// A Google-only admin (no password) with a session created directly in SQL, so
// the test controls authenticated_at. Returns the cookie header to send.
async function createOAuthAdmin(email: string, authenticatedAtSql: string | null): Promise<string> {
  const { rows: [acct] } = await pool.query<{ id: number }>(
    `INSERT INTO accounts (email, password_hash, zone, zone_location_label, email_verified, role)
     VALUES ($1, NULL, '7b', 'Test City', true, 'admin')
     RETURNING id`,
    [email],
  );
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await pool.query(
    `INSERT INTO guest_sessions (token_hash, expires_at, account_id, migrated_at, authenticated_at)
     VALUES ($1, $2, $3, now(), ${authenticatedAtSql ?? 'NULL'})`,
    [hashToken(token), expiresAt, acct.id],
  );
  const sig = crypto.createHmac('sha256', process.env.SESSION_SECRET!).update(token).digest('hex');
  return `${COOKIE_NAME}=${encodeURIComponent(`${token}.${sig}`)}`;
}

async function roleOf(id: number): Promise<string> {
  const { rows } = await pool.query<{ role: string }>('SELECT role FROM accounts WHERE id = $1', [id]);
  return rows[0].role;
}

async function allAuditRows() {
  const { rows } = await pool.query(
    'SELECT admin_id, action, target_type, target_id, before, after FROM admin_audit_log ORDER BY id',
  );
  return rows;
}

async function adminCount(): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM accounts WHERE role = 'admin'`,
  );
  return rows[0].n;
}

let A: number;
let B: number;
let C: number;
let U: number;
let agentA: ReturnType<typeof request.agent>;

beforeEach(async () => {
  await resetDb();
  A = await createUser('role-a@example.com', 'admin');
  B = await createUser('role-b@example.com', 'admin');
  C = await createUser('role-c@example.com', 'admin');
  U = await createUser('role-u@example.com', 'user');
  agentA = await loginAgent('role-a@example.com');
});

afterAll(() => pool.end());

function setRole(agent: ReturnType<typeof request.agent>, id: number, body: object) {
  return agent.patch(`/api/admin/accounts/${id}/role`).send(body);
}

describe('PATCH /api/admin/accounts/:id/role — step-up', () => {
  it('requires currentPassword for a password admin', async () => {
    const res = await setRole(agentA, U, { role: 'admin' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'currentPassword is required' });
    expect(await roleOf(U)).toBe('user');
    expect(await allAuditRows()).toHaveLength(0);
  });

  it('rejects a wrong password with 403 password_incorrect', async () => {
    const res = await setRole(agentA, U, { role: 'admin', currentPassword: 'WrongPass1!' });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Current password is incorrect', code: 'password_incorrect' });
    expect(await roleOf(U)).toBe('user');
    expect(await allAuditRows()).toHaveLength(0);
  });

  it('promotes with the right password and writes one audit row', async () => {
    const res = await setRole(agentA, U, { role: 'admin', currentPassword: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: U, role: 'admin' });
    expect(await roleOf(U)).toBe('admin');
    const rows = await allAuditRows();
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].admin_id)).toBe(A);
    expect(rows[0].action).toBe('account.role');
    expect(rows[0].target_type).toBe('account');
    expect(Number(rows[0].target_id)).toBe(U);
    expect(rows[0].before).toEqual({ role: 'user' });
    expect(rows[0].after).toEqual({ role: 'admin' });
  });

  it('returns 200 with no audit row when the role is unchanged', async () => {
    const res = await setRole(agentA, U, { role: 'user', currentPassword: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: U, role: 'user' });
    expect(await allAuditRows()).toHaveLength(0);
  });

  it('allows a Google-only admin who signed in 5 minutes ago', async () => {
    const cookie = await createOAuthAdmin('role-g@example.com', `now() - interval '5 minutes'`);
    const res = await request(app)
      .patch(`/api/admin/accounts/${U}/role`)
      .set('Cookie', cookie)
      .send({ role: 'admin' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: U, role: 'admin' });
    expect(await allAuditRows()).toHaveLength(1);
  });

  it('requires a fresh sign-in for a Google-only admin (11 minutes ago or never)', async () => {
    const stale = await createOAuthAdmin('role-g-old@example.com', `now() - interval '11 minutes'`);
    const never = await createOAuthAdmin('role-g-null@example.com', null);
    for (const cookie of [stale, never]) {
      const res = await request(app)
        .patch(`/api/admin/accounts/${U}/role`)
        .set('Cookie', cookie)
        .send({ role: 'admin' });
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'Sign in again to change roles', code: 'reauth_required' });
    }
    expect(await roleOf(U)).toBe('user');
    expect(await allAuditRows()).toHaveLength(0);
  });

  it('returns 404 for a missing target with no audit row', async () => {
    const res = await setRole(agentA, 99999, { role: 'admin', currentPassword: PASSWORD });
    expect(res.status).toBe(404);
    expect(await allAuditRows()).toHaveLength(0);
  });

  it('refuses a self-change before any password check', async () => {
    const res = await setRole(agentA, A, { role: 'user' });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Cannot change your own role.' });
  });
});

describe('PATCH /api/admin/accounts/:id/role — two-admin floor', () => {
  it('allows a demotion at 3 admins and refuses one at 2', async () => {
    const first = await setRole(agentA, B, { role: 'user', currentPassword: PASSWORD });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ id: B, role: 'user' });

    const second = await setRole(agentA, C, { role: 'user', currentPassword: PASSWORD });
    expect(second.status).toBe(409);
    expect(second.body).toEqual({ error: 'At least two admins must remain.' });
    expect(await roleOf(C)).toBe('admin');
    expect(await allAuditRows()).toHaveLength(1);
  });

  it('serializes concurrent demotions so exactly two admins remain', async () => {
    const agentC = await loginAgent('role-c@example.com');
    const results = await Promise.all([
      setRole(agentA, B, { role: 'user', currentPassword: PASSWORD }),
      setRole(agentC, A, { role: 'user', currentPassword: PASSWORD }),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);
    expect(await adminCount()).toBe(2);
    expect(await allAuditRows()).toHaveLength(1);
  });
});

describe('PATCH /api/admin/accounts/:id/role — owner', () => {
  it('lets the owner demote an admin below the floor', async () => {
    await pool.query(`UPDATE accounts SET role = 'user' WHERE id = $1`, [C]);
    await pool.query('UPDATE accounts SET is_owner = true WHERE id = $1', [A]);
    const res = await setRole(agentA, B, { role: 'user', currentPassword: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: B, role: 'user' });
    expect(await allAuditRows()).toHaveLength(1);
  });

  it("refuses to change the owner's role", async () => {
    await pool.query('UPDATE accounts SET is_owner = true WHERE id = $1', [C]);
    const res = await setRole(agentA, C, { role: 'user', currentPassword: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "The owner's role can't be changed here." });
    expect(await roleOf(C)).toBe('admin');
    expect(await allAuditRows()).toHaveLength(0);
  });

  it('the DB refuses a non-admin owner and a second owner', async () => {
    await pool.query('UPDATE accounts SET is_owner = true WHERE id = $1', [A]);
    await expect(
      pool.query(`UPDATE accounts SET role = 'user' WHERE id = $1`, [A]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query('UPDATE accounts SET is_owner = true WHERE id = $1', [B]),
    ).rejects.toMatchObject({ code: '23505' });
  });
});

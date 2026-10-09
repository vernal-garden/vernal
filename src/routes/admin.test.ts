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
  role: 'user' | 'admin' = 'user',
  password = 'Password123!',
): Promise<number> {
  const hash = await bcrypt.hash(password, 4);
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO accounts
       (email, password_hash, zone, zone_location_label, email_verified, role)
     VALUES ($1, $2, '7b', 'Test City', true, $3)
     RETURNING id`,
    [email, hash, role],
  );
  return rows[0].id;
}

async function loginAgent(email: string, password = 'Password123!') {
  const agent = request.agent(app);
  await agent.post('/api/auth/guest');
  await agent.post('/api/auth/login').send({ email, password });
  return agent;
}

let adminId: number;
let adminAgent: ReturnType<typeof request.agent>;
let userAgent: ReturnType<typeof request.agent>;

const ADMIN_EMAIL = 'admin-dashboard@example.com';
const USER_EMAIL = 'regular-user@example.com';

beforeAll(async () => {
  await resetDb();
  adminId = await createUser(ADMIN_EMAIL, 'admin');
  await createUser(USER_EMAIL, 'user');
  adminAgent = await loginAgent(ADMIN_EMAIL);
  userAgent = await loginAgent(USER_EMAIL);
});

afterAll(() => pool.end());

// ── GET /api/admin/stats ──────────────────────────────────────────────────────

describe('GET /api/admin/stats', () => {
  it('returns 403 with no session', async () => {
    const res = await request(app).get('/api/admin/stats');
    expect(res.status).toBe(403);
  });

  it('returns 403 for a regular user', async () => {
    const res = await userAgent.get('/api/admin/stats');
    expect(res.status).toBe(403);
  });

  it('returns 200 with accounts and subscriptions for an admin', async () => {
    const res = await adminAgent.get('/api/admin/stats');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('accounts');
    expect(res.body).toHaveProperty('subscriptions');
  });
});

// ── GET /api/admin/accounts ───────────────────────────────────────────────────

describe('GET /api/admin/accounts', () => {
  it('returns an array of accounts for an admin', async () => {
    const res = await adminAgent.get('/api/admin/accounts');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('finds the admin account via ?email= search', async () => {
    const res = await adminAgent.get(
      `/api/admin/accounts?email=${encodeURIComponent(ADMIN_EMAIL)}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.data.some((a: { email: string }) => a.email === ADMIN_EMAIL)).toBe(true);
  });
});

// ── GET /api/admin/accounts/:id ───────────────────────────────────────────────

describe('GET /api/admin/accounts/:id', () => {
  it('returns the account with an integer gardenCount for an admin', async () => {
    const res = await adminAgent.get(`/api/admin/accounts/${adminId}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.gardenCount).toBe('number');
    expect(Number.isInteger(res.body.gardenCount)).toBe(true);
  });

  it('returns 404 for a nonexistent account', async () => {
    const res = await adminAgent.get('/api/admin/accounts/99999');
    expect(res.status).toBe(404);
  });
});

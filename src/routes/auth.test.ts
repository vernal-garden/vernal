import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import bcrypt from 'bcrypt';
import app from '../index';

const pool = new Pool({
  connectionString: process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL,
});

async function resetDb() {
  await pool.query(
    'TRUNCATE accounts, guest_sessions, password_reset_tokens RESTART IDENTITY CASCADE',
  );
}

// Direct DB insert — bypasses bcrypt cost for speed (4 rounds)
async function createUser(email: string, password: string): Promise<number> {
  const hash = await bcrypt.hash(password, 4);
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO accounts (email, password_hash, zone, zone_location_label)
     VALUES ($1, $2, 'unknown', 'Test')
     RETURNING id`,
    [email, hash],
  );
  return rows[0].id;
}

beforeAll(resetDb);
afterAll(() => pool.end());

// ── Phase 05: Guest Sessions ───────────────────────────────────────────────

describe('POST /api/auth/guest', () => {
  it('creates a guest session and sets a cookie', async () => {
    const res = await request(app).post('/api/auth/guest');
    expect(res.status).toBe(201);
    expect(res.headers['set-cookie']).toBeDefined();
    expect(res.body.data.isGuest).toBe(true);
  });

  it('creates distinct sessions for separate requests', async () => {
    await request(app).post('/api/auth/guest');
    await request(app).post('/api/auth/guest');
    const rows = await pool.query('SELECT COUNT(*) AS count FROM guest_sessions');
    expect(parseInt(rows.rows[0].count, 10)).toBeGreaterThanOrEqual(2);
  });
});

describe('GET /api/auth/session', () => {
  it('returns guest state for a guest cookie', async () => {
    const guestRes = await request(app).post('/api/auth/guest');
    const cookie = guestRes.headers['set-cookie'] as unknown as string[];

    const res = await request(app)
      .get('/api/auth/session')
      .set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.data.isGuest).toBe(true);
    expect(res.body.data.authenticated).toBe(false);
  });

  it('returns unauthenticated state with no cookie', async () => {
    const res = await request(app).get('/api/auth/session');
    expect(res.status).toBe(200);
    expect(res.body.data.authenticated).toBe(false);
  });
});

describe('DELETE /api/auth/session', () => {
  it('clears the session cookie', async () => {
    const guestRes = await request(app).post('/api/auth/guest');
    const cookie = guestRes.headers['set-cookie'] as unknown as string[];

    const res = await request(app)
      .delete('/api/auth/session')
      .set('Cookie', cookie);

    expect(res.status).toBe(200);
  });
});

// ── Phase 06: Account Auth ─────────────────────────────────────────────────

describe('POST /api/auth/register', () => {
  it('creates an account and migrates the guest session', async () => {
    const guestRes = await request(app).post('/api/auth/guest');
    const cookie = guestRes.headers['set-cookie'] as unknown as string[];

    const res = await request(app)
      .post('/api/auth/register')
      .set('Cookie', cookie)
      .send({ email: 'register-ok@example.com', password: 'Password123!' });

    expect(res.status).toBe(201);
    expect(res.body.data.authenticated).toBe(true);
    expect(res.body.data.account.email).toBe('register-ok@example.com');
  });

  it('returns 409 for a duplicate email', async () => {
    await createUser('dup@example.com', 'Password123!');

    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'dup@example.com', password: 'Password123!' });

    expect(res.status).toBe(409);
  });

  it('returns 400 when password is missing', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'nopass@example.com' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when password is fewer than 8 characters', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'short@example.com', password: 'abc' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/auth/login', () => {
  it('authenticates with correct credentials', async () => {
    await createUser('login-ok@example.com', 'CorrectPass1!');

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'login-ok@example.com', password: 'CorrectPass1!' });

    expect(res.status).toBe(200);
    expect(res.body.data.authenticated).toBe(true);
    expect(res.headers['set-cookie']).toBeDefined();
  });

  it('returns 401 for a wrong password', async () => {
    await createUser('wrong-pass@example.com', 'RightPassword1!');

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'wrong-pass@example.com', password: 'WrongPassword!' });

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid/i);
  });

  it('returns 401 for an unknown email', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@example.com', password: 'SomePassword1!' });

    expect(res.status).toBe(401);
  });
});

describe('POST /api/auth/forgot-password', () => {
  it('returns 200 regardless of whether the email exists', async () => {
    const res = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'nonexistent@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.data.message).toMatch(/if an account/i);
  });
});

// ── Phase 07: Google OAuth ─────────────────────────────────────────────────

describe('GET /api/auth/oauth/:provider — unknown provider', () => {
  it('returns 400 for an unsupported provider', async () => {
    const res = await request(app).get('/api/auth/oauth/twitter');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown/i);
  });
});

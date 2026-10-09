import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { Pool } from 'pg';
import bcrypt from 'bcrypt';
import app from '../index';
import { COOKIE_NAME } from '../lib/sessions';

const pool = new Pool({
  connectionString: process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL,
});

async function resetDb() {
  await pool.query('TRUNCATE accounts, guest_sessions RESTART IDENTITY CASCADE');
}

async function createUser(email: string, password = 'Password123!'): Promise<number> {
  const hash = await bcrypt.hash(password, 4);
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO accounts (email, password_hash, zone, zone_location_label)
     VALUES ($1, $2, 'unknown', 'Test')
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

// Mirrors the signing scheme in src/lib/sessions.ts (signToken) so tests can
// mint a cookie for a session row inserted directly via SQL.
function signToken(rawToken: string): string {
  const secret = process.env.SESSION_SECRET!;
  const sig = crypto.createHmac('sha256', secret).update(rawToken).digest('hex');
  return `${rawToken}.${sig}`;
}

beforeAll(resetDb);
afterAll(() => pool.end());

describe('Numeric ID validation', () => {
  let agent: ReturnType<typeof request.agent>;

  beforeAll(async () => {
    await createUser('security-user@example.com');
    agent = await loginAgent('security-user@example.com');
  });

  it('returns 400 for a non-numeric garden id', async () => {
    const res = await agent.get('/api/gardens/abc');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid id/i);
  });

  it('returns 404 for a valid but non-existent garden id', async () => {
    const res = await agent.get('/api/gardens/999999999');
    expect(res.status).toBe(404);
  });
});

describe('Session expiry', () => {
  it('rejects a request whose session row has already expired', async () => {
    const rawToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() - 60 * 1000); // 1 minute in the past

    await pool.query(
      `INSERT INTO guest_sessions (token, expires_at) VALUES ($1, $2)`,
      [rawToken, expiresAt],
    );

    const cookie = `${COOKIE_NAME}=${signToken(rawToken)}`;

    const res = await request(app)
      .get('/api/gardens')
      .set('Cookie', cookie);

    expect(res.status).toBe(401);
  });
});

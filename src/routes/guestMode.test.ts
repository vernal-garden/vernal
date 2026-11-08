import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import app from '../index';
import { invalidateBetaSettings } from '../lib/beta';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL must be set to run tests');
const pool = new Pool({ connectionString: url });

async function setGuestMode(on: boolean) {
  await pool.query('UPDATE beta_settings SET guest_mode_on = $1 WHERE id = 1', [on]);
  invalidateBetaSettings();
}

async function sessionCount() {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM guest_sessions');
  return rows[0].n as number;
}

beforeEach(async () => {
  await pool.query('TRUNCATE accounts, guest_sessions, password_reset_tokens RESTART IDENTITY CASCADE');
  await setGuestMode(true);
});

afterAll(async () => {
  await setGuestMode(true);
  await pool.end();
});

describe('POST /api/auth/guest with guest mode', () => {
  it('creates a guest session when on', async () => {
    const res = await request(app).post('/api/auth/guest');
    expect(res.status).toBe(201);
    expect(res.headers['set-cookie']).toBeDefined();
  });

  it('refuses a new visitor when off, creating nothing', async () => {
    await setGuestMode(false);
    const res = await request(app).post('/api/auth/guest');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Vernal is in private beta.', code: 'guest_mode_off' });
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(await sessionCount()).toBe(0);
  });

  it('still returns an existing guest session when off', async () => {
    const agent = request.agent(app);
    expect((await agent.post('/api/auth/guest')).status).toBe(201);
    await setGuestMode(false);
    const res = await agent.post('/api/auth/guest');
    expect(res.status).toBe(200);
    expect(res.body.data.isGuest).toBe(true);
    const session = await agent.get('/api/auth/session');
    expect(session.body.data.isGuest).toBe(true);
    expect(await sessionCount()).toBe(1);
  });
});

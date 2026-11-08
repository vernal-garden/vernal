import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { Pool } from 'pg';

// betaTermsPending imports the constant, so it is replaced at module level; the
// getter lets each test bump the "current" version.
const stub = vi.hoisted(() => ({ version: '2026-11-16' }));
vi.mock('../lib/legal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/legal')>();
  return {
    ...actual,
    get BETA_TERMS_VERSION() {
      return stub.version;
    },
  };
});

import app from '../index';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL must be set to run tests');

const pool = new Pool({ connectionString: url });
const PASSWORD = 'Password123!';
const email = 'versioned@example.com';

beforeEach(async () => {
  stub.version = '2026-11-16';
  await pool.query('TRUNCATE accounts, guest_sessions, password_reset_tokens RESTART IDENTITY CASCADE');
  const hash = await bcrypt.hash(PASSWORD, 4);
  await pool.query(
    `INSERT INTO accounts
       (email, password_hash, zone, zone_location_label, email_verified, beta_participant_at, beta_terms_version)
     VALUES ($1, $2, '7b', 'Test City', true, now(), '2026-11-16')`,
    [email, hash],
  );
});

afterAll(async () => {
  await pool.end();
});

describe('a new beta terms version', () => {
  it('makes an accepted participant pending again until they accept it', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/guest');
    await agent.post('/api/auth/login').send({ email, password: PASSWORD });
    expect((await agent.get('/api/gardens')).status).toBe(200);

    stub.version = '2027-02-01';
    const held = await agent.get('/api/gardens');
    expect(held.status).toBe(403);
    expect(held.body.code).toBe('beta_terms_required');
    expect((await agent.get('/api/auth/session')).body.data.account.betaTermsRequired).toBe(true);

    expect((await agent.post('/api/me/beta-terms').send({ accept: true })).status).toBe(204);
    const { rows } = await pool.query('SELECT beta_terms_version FROM accounts WHERE email = $1', [email]);
    expect(rows[0].beta_terms_version).toBe('2027-02-01');
    expect((await agent.get('/api/gardens')).status).toBe(200);
  });
});

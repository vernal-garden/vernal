import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { Pool } from 'pg';

// No key on this server: deletion must still work.
vi.mock('../lib/stripe', () => ({
  getStripe: () => {
    throw new Error('Stripe is not available: BILLING=off');
  },
  getStripeForCleanup: () => null,
}));

import app from '../index';
import { getServerConfig, setServerConfigForTests } from '../lib/serverConfig';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL must be set to run tests');
const pool = new Pool({ connectionString: url });
const original = getServerConfig();

async function reset() {
  await pool.query('TRUNCATE accounts, guest_sessions RESTART IDENTITY CASCADE');
}

beforeAll(reset);
beforeEach(async () => {
  await reset();
  setServerConfigForTests({ ...original, billing: 'off' });
});
afterAll(async () => {
  setServerConfigForTests(original);
  await pool.end();
});

describe('DELETE /api/me with billing off and no Stripe key', () => {
  it('schedules deletion for an account that still has a Stripe subscription', async () => {
    const hash = await bcrypt.hash('Password123!', 4);
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO accounts
         (email, password_hash, zone, zone_location_label, email_verified, subscription_tier, stripe_subscription_id)
       VALUES ('gone@example.com', $1, '7b', 'Test City', true, 'free', 'sub_left_behind')
       RETURNING id`,
      [hash],
    );
    const agent = request.agent(app);
    await agent.post('/api/auth/guest');
    const login = await agent.post('/api/auth/login').send({ email: 'gone@example.com', password: 'Password123!' });
    expect(login.status).toBe(200);

    const res = await agent.delete('/api/me');
    expect(res.status).toBe(204);
    const { rows: after } = await pool.query('SELECT deletion_scheduled_at FROM accounts WHERE id = $1', [rows[0].id]);
    expect(after[0].deletion_scheduled_at).not.toBeNull();
  });
});

describe('POST /api/me/cancel-deletion with billing off and no Stripe key', () => {
  it('cancels deletion for an account that still has a Stripe subscription', async () => {
    const hash = await bcrypt.hash('Password123!', 4);
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO accounts
         (email, password_hash, zone, zone_location_label, email_verified, subscription_tier,
          stripe_subscription_id, deletion_scheduled_at)
       VALUES ('back@example.com', $1, '7b', 'Test City', true, 'free', 'sub_left_behind', NOW())
       RETURNING id`,
      [hash],
    );
    const agent = request.agent(app);
    await agent.post('/api/auth/guest');
    const login = await agent.post('/api/auth/login').send({ email: 'back@example.com', password: 'Password123!' });
    expect(login.status).toBe(200);

    const res = await agent.post('/api/me/cancel-deletion');
    expect(res.status).toBe(200);
    const { rows: after } = await pool.query('SELECT deletion_scheduled_at FROM accounts WHERE id = $1', [rows[0].id]);
    expect(after[0].deletion_scheduled_at).toBeNull();
  });
});

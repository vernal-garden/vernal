import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { Pool } from 'pg';
import app from '../index';
import { getServerConfig, setServerConfigForTests } from '../lib/serverConfig';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL must be set to run tests');

const pool = new Pool({ connectionString: url });
const original = getServerConfig();

function setBilling(billing: 'stripe' | 'off') {
  setServerConfigForTests({ ...original, billing });
}

async function createFreeUser(email: string): Promise<number> {
  const hash = await bcrypt.hash('Password123!', 4);
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO accounts
       (email, password_hash, zone, zone_location_label, email_verified, subscription_tier)
     VALUES ($1, $2, '7b', 'Test City', true, 'free')
     RETURNING id`,
    [email, hash],
  );
  return rows[0].id;
}

async function loginAgent(email: string) {
  const agent = request.agent(app);
  await agent.post('/api/auth/guest');
  const login = await agent.post('/api/auth/login').send({ email, password: 'Password123!' });
  return { agent, login };
}

async function storedTier(id: number) {
  const { rows } = await pool.query(
    'SELECT subscription_tier, subscription_interval FROM accounts WHERE id = $1',
    [id],
  );
  return rows[0];
}

beforeAll(() => pool.query('TRUNCATE accounts, guest_sessions RESTART IDENTITY CASCADE'));
afterEach(() => setServerConfigForTests(original));
afterAll(() => pool.end());

describe('billing off', () => {
  let id: number;
  beforeEach(async () => {
    await pool.query('TRUNCATE accounts, guest_sessions RESTART IDENTITY CASCADE');
    id = await createFreeUser('billing-off@example.com');
  });

  it('GET /api/subscription reports a supporter with billing: false', async () => {
    setBilling('off');
    const { agent } = await loginAgent('billing-off@example.com');
    const res = await agent.get('/api/subscription');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ tier: 'supporter', isSupporter: true, billing: false, hasCustomer: false });
  });

  it('GET /api/subscription reports the stored tier with billing: true when on', async () => {
    setBilling('stripe');
    const { agent } = await loginAgent('billing-off@example.com');
    const res = await agent.get('/api/subscription');
    expect(res.body).toMatchObject({ tier: 'free', isSupporter: false, billing: true });
  });

  it('checkout and portal return 404 when off', async () => {
    setBilling('off');
    const { agent } = await loginAgent('billing-off@example.com');
    for (const path of ['/api/subscription/checkout', '/api/subscription/portal']) {
      const res = await agent.post(path).send({ interval: 'monthly' });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "Billing isn't set up on this server." });
    }
  });

  it('the Stripe webhook is not mounted when off, and is when on', async () => {
    setBilling('off');
    const off = await request(app)
      .post('/api/webhooks/stripe')
      .set('content-type', 'application/json')
      .send('{}');
    expect(off.status).toBe(404);
    setBilling('stripe');
    const on = await request(app)
      .post('/api/webhooks/stripe')
      .set('content-type', 'application/json')
      .send('{}');
    expect(on.status).toBe(400); // reaches the handler: missing signature
  });

  it('requireSupporter passes a free-stored account when off and blocks it when on', async () => {
    setBilling('stripe');
    const on = await loginAgent('billing-off@example.com');
    expect((await on.agent.get('/api/weather/current')).status).toBe(402);

    setBilling('off');
    const off = await loginAgent('billing-off@example.com');
    expect((await off.agent.get('/api/weather/current')).status).not.toBe(402);
  });

  it('login, session and /api/me show supporter when off', async () => {
    setBilling('off');
    const { agent, login } = await loginAgent('billing-off@example.com');
    expect(login.body.data.account.subscriptionTier).toBe('supporter');
    expect((await agent.get('/api/auth/session')).body.data.account.subscriptionTier).toBe('supporter');
    expect((await agent.get('/api/me')).body.data.subscriptionTier).toBe('supporter');
  });

  it('never writes a stored tier', async () => {
    setBilling('off');
    const { agent } = await loginAgent('billing-off@example.com');
    await agent.get('/api/auth/session');
    await agent.get('/api/me');
    await agent.get('/api/subscription');
    await agent.post('/api/subscription/checkout').send({ interval: 'monthly' });
    expect(await storedTier(id)).toEqual({ subscription_tier: 'free', subscription_interval: null });
  });
});

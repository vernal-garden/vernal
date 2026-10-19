import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { Pool } from 'pg';
import app from '../index';
import { stripe as appStripe } from '../lib/stripe';

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
  { stripeCustomerId }: { stripeCustomerId?: string } = {},
): Promise<number> {
  const hash = await bcrypt.hash('Password123!', 4);
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO accounts
       (email, password_hash, zone, zone_location_label, email_verified, stripe_customer_id)
     VALUES ($1, $2, '7b', 'Test City', true, $3)
     RETURNING id`,
    [email, hash, stripeCustomerId ?? null],
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

// ── GET /api/subscription ──────────────────────────────────────────────────────

describe('GET /api/subscription', () => {
  it('returns free tier defaults for a new account', async () => {
    await createUser('sub-get@example.com');
    const agent = await loginAgent('sub-get@example.com');

    const res = await agent.get('/api/subscription');
    expect(res.status).toBe(200);
    expect(res.body.tier).toBe('free');
    expect(res.body.isSupporter).toBe(false);
    expect(res.body.interval).toBeNull();
    expect(res.body.periodEnd).toBeNull();
    expect(res.body.cancelledAt).toBeNull();
    expect(res.body.hasCustomer).toBe(false);
  });

  it('returns 401 with no session', async () => {
    const res = await request(app).get('/api/subscription');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/subscription/checkout — scheduled deletion', () => {
  it('returns 409 before touching Stripe when deletion is scheduled', async () => {
    const id = await createUser('sub-checkout-deleting@example.com');
    await pool.query('UPDATE accounts SET deletion_scheduled_at = NOW() WHERE id = $1', [id]);
    const agent = await loginAgent('sub-checkout-deleting@example.com');

    const res = await agent.post('/api/subscription/checkout').send({ interval: 'monthly' });
    expect(res.status).toBe(409);
    const { rows } = await pool.query('SELECT stripe_customer_id FROM accounts WHERE id = $1', [id]);
    expect(rows[0].stripe_customer_id).toBeNull();
  });
});

describe('POST /api/subscription/checkout — guards', () => {
  const customersCreate = vi.spyOn(appStripe.customers, 'create');
  const sessionsCreate = vi.spyOn(appStripe.checkout.sessions, 'create');
  const listSubs = vi.spyOn(appStripe.subscriptions, 'list');

  beforeEach(() => {
    customersCreate.mockReset();
    sessionsCreate.mockReset();
    listSubs.mockReset();
    customersCreate.mockResolvedValue({ id: 'cus_created' } as never);
    sessionsCreate.mockResolvedValue({ url: 'https://checkout.test/session' } as never);
    listSubs.mockResolvedValue({ data: [] } as never);
  });

  async function supporter(email: string, interval: 'monthly' | 'annual' | 'lifetime') {
    const id = await createUser(email, { stripeCustomerId: `cus_${email.split('@')[0]}` });
    await pool.query(
      `UPDATE accounts SET subscription_tier = 'supporter', subscription_interval = $1 WHERE id = $2`,
      [interval, id],
    );
    return loginAgent(email);
  }

  it('returns 409 already_supporter for a lifetime supporter', async () => {
    const agent = await supporter('co-lifetime@example.com', 'lifetime');
    const res = await agent.post('/api/subscription/checkout').send({ interval: 'lifetime' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "You're already a supporter.", code: 'already_supporter' });
    expect(sessionsCreate).not.toHaveBeenCalled();
  });

  it('returns 409 when a monthly supporter asks for annual', async () => {
    const agent = await supporter('co-monthly@example.com', 'monthly');
    const res = await agent.post('/api/subscription/checkout').send({ interval: 'annual' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('already_supporter');
  });

  it('lets a monthly supporter upgrade to lifetime', async () => {
    const agent = await supporter('co-upgrade@example.com', 'monthly');
    const res = await agent.post('/api/subscription/checkout').send({ interval: 'lifetime' });
    expect(res.status).toBe(200);
    expect(sessionsCreate.mock.calls[0][0]).toMatchObject({ mode: 'payment', customer: 'cus_co-upgrade' });
  });

  it('creates the customer with an idempotency key and stores it', async () => {
    const id = await createUser('co-new@example.com');
    const agent = await loginAgent('co-new@example.com');
    const res = await agent.post('/api/subscription/checkout').send({ interval: 'monthly' });
    expect(res.status).toBe(200);
    expect(customersCreate.mock.calls[0][1]).toEqual({
      idempotencyKey: expect.stringMatching(new RegExp(`^customer-create-[0-9a-f]{12}-${id}$`)),
    });
    const { rows } = await pool.query('SELECT stripe_customer_id FROM accounts WHERE id = $1', [id]);
    expect(rows[0].stripe_customer_id).toBe('cus_created');
  });

  it('reuses an existing customer', async () => {
    await createUser('co-existing@example.com', { stripeCustomerId: 'cus_existing' });
    const agent = await loginAgent('co-existing@example.com');
    await agent.post('/api/subscription/checkout').send({ interval: 'monthly' });
    expect(customersCreate).not.toHaveBeenCalled();
    expect(sessionsCreate.mock.calls[0][0]).toMatchObject({ customer: 'cus_existing' });
  });

  it('returns 409 when a free account already has a live subscription at Stripe', async () => {
    await createUser('co-live@example.com', { stripeCustomerId: 'cus_live' });
    const agent = await loginAgent('co-live@example.com');
    listSubs.mockResolvedValueOnce({ data: [{ id: 'sub_live', status: 'active' }] } as never);
    const res = await agent.post('/api/subscription/checkout').send({ interval: 'monthly' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "You're already a supporter.", code: 'already_supporter' });
    expect(listSubs).toHaveBeenCalledWith({ customer: 'cus_live', status: 'all', limit: 10 });
    expect(sessionsCreate).not.toHaveBeenCalled();
  });

  it('uses the stored customer when a concurrent request saved one first', async () => {
    const id = await createUser('co-race@example.com');
    const agent = await loginAgent('co-race@example.com');
    customersCreate.mockImplementationOnce((async () => {
      await pool.query("UPDATE accounts SET stripe_customer_id = 'cus_winner' WHERE id = $1", [id]);
      return { id: 'cus_loser' };
    }) as never);
    await agent.post('/api/subscription/checkout').send({ interval: 'monthly' });
    expect(sessionsCreate.mock.calls[0][0]).toMatchObject({ customer: 'cus_winner' });
    const { rows } = await pool.query('SELECT stripe_customer_id FROM accounts WHERE id = $1', [id]);
    expect(rows[0].stripe_customer_id).toBe('cus_winner');
  });

  describe('rate limit', () => {
    beforeEach(() => {
      process.env.ENFORCE_RATE_LIMITS = 'true';
    });
    afterEach(() => {
      delete process.env.ENFORCE_RATE_LIMITS;
    });

    it('allows 10 attempts an hour per account, then 429', async () => {
      await createUser('co-limit@example.com');
      const agent = await loginAgent('co-limit@example.com');
      for (let i = 0; i < 10; i++) {
        expect((await agent.post('/api/subscription/checkout').send({ interval: 'bogus' })).status).toBe(400);
      }
      expect((await agent.post('/api/subscription/checkout').send({ interval: 'bogus' })).status).toBe(429);
    });
  });
});

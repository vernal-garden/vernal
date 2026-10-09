import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { Pool } from 'pg';
import Stripe from 'stripe';
import app from '../index';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL must be set to run tests');

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

const pool = new Pool({ connectionString: url });
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

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

function signPayload(payload: string) {
  return stripe.webhooks.generateTestHeaderString({
    payload,
    secret: WEBHOOK_SECRET!,
  });
}

async function postWebhook(payload: object, signature?: string) {
  const raw = JSON.stringify(payload);
  const req = request(app)
    .post('/api/webhooks/stripe')
    .set('Content-Type', 'application/json');
  if (signature !== undefined) {
    req.set('stripe-signature', signature);
  }
  return req.send(raw);
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

// ── POST /api/webhooks/stripe — signature verification ────────────────────────

describe('POST /api/webhooks/stripe — signature verification', () => {
  it('returns 400 with a missing signature', async () => {
    const res = await postWebhook({ id: 'evt_test', type: 'customer.subscription.updated' });
    expect(res.status).toBe(400);
  });

  it('returns 400 with an invalid signature', async () => {
    const res = await postWebhook(
      { id: 'evt_test', type: 'customer.subscription.updated' },
      't=1,v1=bogus',
    );
    expect(res.status).toBe(400);
  });
});

// ── POST /api/webhooks/stripe — subscription lifecycle ─────────────────────────

describe.skipIf(!WEBHOOK_SECRET)('POST /api/webhooks/stripe — subscription lifecycle', () => {
  it('customer.subscription.updated with an active status sets tier to supporter', async () => {
    const accountId = await createUser('sub-webhook-active@example.com', {
      stripeCustomerId: 'cus_test_active',
    });

    const payload = {
      id: 'evt_test_active',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_test_active',
          customer: 'cus_test_active',
          status: 'active',
          cancel_at_period_end: false,
          cancel_at: null,
          items: {
            data: [
              {
                current_period_end: 1893456000,
                price: { recurring: { interval: 'month' } },
              },
            ],
          },
        },
      },
    };

    const raw = JSON.stringify(payload);
    const res = await request(app)
      .post('/api/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', signPayload(raw))
      .send(raw);

    expect(res.status).toBe(200);

    const { rows } = await pool.query(
      `SELECT subscription_tier, subscription_interval, subscription_period_end
       FROM accounts WHERE id = $1`,
      [accountId],
    );
    expect(rows[0].subscription_tier).toBe('supporter');
    expect(rows[0].subscription_interval).toBe('monthly');
    expect(rows[0].subscription_period_end).not.toBeNull();
  });

  it('customer.subscription.deleted resets the account to free', async () => {
    const accountId = await createUser('sub-webhook-deleted@example.com', {
      stripeCustomerId: 'cus_test_deleted',
    });
    await pool.query(
      `UPDATE accounts SET subscription_tier = 'supporter', stripe_subscription_id = 'sub_test_deleted'
       WHERE id = $1`,
      [accountId],
    );

    const payload = {
      id: 'evt_test_deleted',
      type: 'customer.subscription.deleted',
      data: {
        object: {
          id: 'sub_test_deleted',
          customer: 'cus_test_deleted',
          status: 'canceled',
        },
      },
    };

    const raw = JSON.stringify(payload);
    const res = await request(app)
      .post('/api/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', signPayload(raw))
      .send(raw);

    expect(res.status).toBe(200);

    const { rows } = await pool.query(
      `SELECT subscription_tier, stripe_subscription_id, subscription_period_end
       FROM accounts WHERE id = $1`,
      [accountId],
    );
    expect(rows[0].subscription_tier).toBe('free');
    expect(rows[0].stripe_subscription_id).toBeNull();
    expect(rows[0].subscription_period_end).toBeNull();
  });

  it('checkout.session.completed in payment mode sets a lifetime supporter', async () => {
    const accountId = await createUser('sub-webhook-lifetime@example.com', {
      stripeCustomerId: 'cus_test_lifetime',
    });

    const payload = {
      id: 'evt_test_lifetime',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_lifetime',
          mode: 'payment',
          customer: 'cus_test_lifetime',
        },
      },
    };

    const raw = JSON.stringify(payload);
    const res = await request(app)
      .post('/api/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', signPayload(raw))
      .send(raw);

    expect(res.status).toBe(200);

    const { rows } = await pool.query(
      `SELECT subscription_tier, subscription_interval, subscription_period_end
       FROM accounts WHERE id = $1`,
      [accountId],
    );
    expect(rows[0].subscription_tier).toBe('supporter');
    expect(rows[0].subscription_interval).toBe('lifetime');
    expect(rows[0].subscription_period_end).toBeNull();
  });
});

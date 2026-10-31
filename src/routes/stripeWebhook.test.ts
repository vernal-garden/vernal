import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import Stripe from 'stripe';
import { gzipSync } from 'zlib';
import app from '../index';
import { getStripe } from '../lib/stripe';

const appStripe = getStripe();

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL must be set to run tests');
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

const pool = new Pool({ connectionString: url });
const signer = new Stripe(process.env.STRIPE_SECRET_KEY!);

const retrieveSub = vi.spyOn(appStripe.subscriptions, 'retrieve');
const cancelSub = vi.spyOn(appStripe.subscriptions, 'cancel');
const listSubs = vi.spyOn(appStripe.subscriptions, 'list');

let seq = 0;

interface AccountFields {
  tier?: 'free' | 'supporter';
  interval?: string | null;
  subId?: string | null;
  paymentIntent?: string | null;
}

// Each account gets its own customer id; returns both.
async function createAccount(fields: AccountFields = {}): Promise<{ id: number; customer: string }> {
  seq += 1;
  const customer = `cus_wh_${seq}`;
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO accounts (email, password_hash, zone, zone_location_label, email_verified,
                           stripe_customer_id, subscription_tier, subscription_interval,
                           stripe_subscription_id, stripe_lifetime_payment_intent)
     VALUES ($1, 'x', '7b', 'Test City', true, $2, $3, $4, $5, $6) RETURNING id`,
    [
      `wh-${seq}@example.com`,
      customer,
      fields.tier ?? 'free',
      fields.interval ?? null,
      fields.subId ?? null,
      fields.paymentIntent ?? null,
    ],
  );
  return { id: rows[0].id, customer };
}

async function accountRow(id: number) {
  const { rows } = await pool.query(
    `SELECT subscription_tier, subscription_interval, stripe_subscription_id, stripe_lifetime_payment_intent
       FROM accounts WHERE id = $1`,
    [id],
  );
  return rows[0];
}

function postSigned(raw: string) {
  return request(app)
    .post('/api/webhooks/stripe')
    .set('Content-Type', 'application/json')
    .set('stripe-signature', signer.webhooks.generateTestHeaderString({ payload: raw, secret: WEBHOOK_SECRET! }))
    .send(raw);
}

function sendEvent(type: string, object: Record<string, unknown>, id = `evt_wh_${++seq}`) {
  return postSigned(JSON.stringify({ id, object: 'event', type, data: { object } }));
}

function sub(id: string, customer: string, status = 'active', overrides: Record<string, unknown> = {}) {
  return {
    id,
    object: 'subscription',
    customer,
    status,
    cancel_at_period_end: false,
    cancel_at: null,
    items: { data: [{ current_period_end: 1893456000, price: { recurring: { interval: 'month' } } }] },
    ...overrides,
  };
}

beforeAll(async () => {
  await pool.query('TRUNCATE accounts, guest_sessions, password_reset_tokens, stripe_events RESTART IDENTITY CASCADE');
});
beforeEach(() => {
  retrieveSub.mockReset();
  cancelSub.mockReset();
  listSubs.mockReset();
  retrieveSub.mockRejectedValue(new Error('unexpected subscriptions.retrieve'));
  cancelSub.mockRejectedValue(new Error('unexpected subscriptions.cancel'));
  listSubs.mockResolvedValue({ data: [] } as never);
});
afterAll(() => pool.end());

describe('POST /api/webhooks/stripe — signature verification', () => {
  it('returns 415 for a gzip-encoded body', async () => {
    const res = await request(app)
      .post('/api/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'gzip')
      .send(gzipSync(Buffer.from('{}')));
    expect(res.status).toBe(415);
  });

  it('returns 400 with a missing signature', async () => {
    const res = await request(app)
      .post('/api/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ id: 'evt_x', type: 'customer.subscription.updated' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 with an invalid signature', async () => {
    const res = await request(app)
      .post('/api/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 't=1,v1=bogus')
      .send(JSON.stringify({ id: 'evt_x', type: 'customer.subscription.updated' }));
    expect(res.status).toBe(400);
  });
});

describe.skipIf(!WEBHOOK_SECRET)('subscription events', () => {
  it('uses the retrieved status, not the payload', async () => {
    const { id, customer } = await createAccount();
    retrieveSub.mockResolvedValueOnce(sub('sub_a', customer, 'active') as never);
    const res = await sendEvent('customer.subscription.updated', sub('sub_a', customer, 'incomplete'));
    expect(res.status).toBe(200);
    expect(retrieveSub).toHaveBeenCalledWith('sub_a');
    expect(await accountRow(id)).toMatchObject({
      subscription_tier: 'supporter',
      subscription_interval: 'monthly',
      stripe_subscription_id: 'sub_a',
    });
  });

  it('adopts a live subscription over a stale stored id', async () => {
    const { id, customer } = await createAccount({ tier: 'free', subId: 'sub_old' });
    retrieveSub.mockResolvedValueOnce(sub('sub_new', customer, 'active') as never);
    await sendEvent('customer.subscription.created', sub('sub_new', customer));
    expect(await accountRow(id)).toMatchObject({ subscription_tier: 'supporter', stripe_subscription_id: 'sub_new' });
  });

  it('ignores a non-live update for a subscription other than the stored one', async () => {
    const { id, customer } = await createAccount({ tier: 'supporter', interval: 'monthly', subId: 'sub_current' });
    retrieveSub.mockResolvedValueOnce(sub('sub_stale', customer, 'canceled') as never);
    await sendEvent('customer.subscription.updated', sub('sub_stale', customer, 'canceled'));
    expect(await accountRow(id)).toMatchObject({ subscription_tier: 'supporter', stripe_subscription_id: 'sub_current' });
  });

  it('deleted resets the stored subscription to free', async () => {
    const { id, customer } = await createAccount({ tier: 'supporter', interval: 'monthly', subId: 'sub_del' });
    retrieveSub.mockResolvedValueOnce(sub('sub_del', customer, 'canceled') as never);
    await sendEvent('customer.subscription.deleted', sub('sub_del', customer, 'canceled'));
    expect(await accountRow(id)).toMatchObject({ subscription_tier: 'free', stripe_subscription_id: null });
  });

  it('deleted for a different subscription id changes nothing', async () => {
    const { id, customer } = await createAccount({ tier: 'supporter', interval: 'monthly', subId: 'sub_keep' });
    retrieveSub.mockResolvedValueOnce(sub('sub_other', customer, 'canceled') as never);
    await sendEvent('customer.subscription.deleted', sub('sub_other', customer, 'canceled'));
    expect(await accountRow(id)).toMatchObject({ subscription_tier: 'supporter', stripe_subscription_id: 'sub_keep' });
  });

  it('never touches a lifetime account', async () => {
    const { id, customer } = await createAccount({ tier: 'supporter', interval: 'lifetime' });
    retrieveSub.mockResolvedValueOnce(sub('sub_x', customer, 'canceled') as never);
    await sendEvent('customer.subscription.deleted', sub('sub_x', customer, 'canceled'));
    expect(await accountRow(id)).toMatchObject({ subscription_tier: 'supporter', subscription_interval: 'lifetime' });
  });

  it('cancels a live subscription on a lifetime account', async () => {
    const { id, customer } = await createAccount({ tier: 'supporter', interval: 'lifetime' });
    // Retrieved twice: once by the webhook, once by cancelSubscriptionNow.
    retrieveSub.mockResolvedValue(sub('sub_dupe_life', customer, 'active') as never);
    cancelSub.mockResolvedValueOnce(sub('sub_dupe_life', customer, 'canceled') as never);
    const res = await sendEvent('customer.subscription.created', sub('sub_dupe_life', customer));
    expect(res.status).toBe(200);
    expect(cancelSub).toHaveBeenCalledWith('sub_dupe_life');
    expect(await accountRow(id)).toMatchObject({
      subscription_tier: 'supporter',
      subscription_interval: 'lifetime',
      stripe_subscription_id: null,
    });
  });

  it('adopts another live subscription instead of downgrading when the stored one is deleted', async () => {
    const { id, customer } = await createAccount({ tier: 'supporter', interval: 'monthly', subId: 'sub_b' });
    retrieveSub.mockResolvedValueOnce(sub('sub_b', customer, 'canceled') as never);
    listSubs.mockResolvedValueOnce({
      data: [sub('sub_b', customer, 'canceled'), sub('sub_a', customer, 'active')],
    } as never);
    const res = await sendEvent('customer.subscription.deleted', sub('sub_b', customer, 'canceled'));
    expect(res.status).toBe(200);
    expect(listSubs).toHaveBeenCalledWith({ customer, status: 'all', limit: 10 });
    expect(await accountRow(id)).toMatchObject({ subscription_tier: 'supporter', stripe_subscription_id: 'sub_a' });
  });
});

describe.skipIf(!WEBHOOK_SECRET)('exactly-once processing', () => {
  it('applies a duplicate event id only once', async () => {
    const { id, customer } = await createAccount();
    retrieveSub.mockResolvedValue(sub('sub_dup', customer, 'active') as never);
    const eventId = 'evt_dup_1';
    expect((await sendEvent('customer.subscription.updated', sub('sub_dup', customer), eventId)).status).toBe(200);
    await pool.query("UPDATE accounts SET subscription_tier = 'free' WHERE id = $1", [id]);

    expect((await sendEvent('customer.subscription.updated', sub('sub_dup', customer), eventId)).status).toBe(200);
    expect((await accountRow(id)).subscription_tier).toBe('free');
    expect(retrieveSub).toHaveBeenCalledTimes(1);
  });

  it('records nothing and returns 500 when a Stripe call fails', async () => {
    const { customer } = await createAccount();
    retrieveSub.mockRejectedValueOnce(new Error('Stripe down'));
    const res = await sendEvent('customer.subscription.updated', sub('sub_fail', customer), 'evt_fail_1');
    expect(res.status).toBe(500);
    const { rowCount } = await pool.query("SELECT 1 FROM stripe_events WHERE event_id = 'evt_fail_1'");
    expect(rowCount).toBe(0);
  });

  it('rolls back the event record when applying fails', async () => {
    const { customer } = await createAccount();
    // A non-numeric period end makes the UPDATE fail inside the transaction.
    retrieveSub.mockResolvedValueOnce(
      sub('sub_bad', customer, 'active', {
        items: { data: [{ current_period_end: 'not-a-number', price: { recurring: { interval: 'month' } } }] },
      }) as never,
    );
    const res = await sendEvent('customer.subscription.updated', sub('sub_bad', customer), 'evt_bad_1');
    expect(res.status).toBe(500);
    const { rowCount } = await pool.query("SELECT 1 FROM stripe_events WHERE event_id = 'evt_bad_1'");
    expect(rowCount).toBe(0);
  });

  it('does not record unhandled event types', async () => {
    const res = await sendEvent('customer.created', { id: 'cus_ignored' }, 'evt_unhandled_1');
    expect(res.status).toBe(200);
    const { rowCount } = await pool.query("SELECT 1 FROM stripe_events WHERE event_id = 'evt_unhandled_1'");
    expect(rowCount).toBe(0);
  });
});

function checkoutSession(customer: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `cs_${++seq}`,
    object: 'checkout.session',
    mode: 'payment',
    payment_status: 'paid',
    customer,
    payment_intent: `pi_${seq}`,
    ...overrides,
  };
}

describe.skipIf(!WEBHOOK_SECRET)('lifetime purchases', () => {
  it('grants lifetime on a paid checkout and stores the payment intent', async () => {
    const { id, customer } = await createAccount();
    await sendEvent('checkout.session.completed', checkoutSession(customer, { payment_intent: 'pi_paid' }));
    expect(await accountRow(id)).toMatchObject({
      subscription_tier: 'supporter',
      subscription_interval: 'lifetime',
      stripe_lifetime_payment_intent: 'pi_paid',
    });
  });

  it('grants nothing while a delayed payment is unpaid', async () => {
    const { id, customer } = await createAccount();
    await sendEvent('checkout.session.completed', checkoutSession(customer, { payment_status: 'unpaid' }));
    expect((await accountRow(id)).subscription_tier).toBe('free');
  });

  it('grants when the delayed payment succeeds', async () => {
    const { id, customer } = await createAccount();
    await sendEvent('checkout.session.async_payment_succeeded', checkoutSession(customer, { payment_intent: 'pi_async' }));
    expect(await accountRow(id)).toMatchObject({ subscription_interval: 'lifetime', stripe_lifetime_payment_intent: 'pi_async' });
  });

  it('only logs a failed delayed payment', async () => {
    const { id, customer } = await createAccount();
    const res = await sendEvent('checkout.session.async_payment_failed', checkoutSession(customer, { payment_status: 'unpaid' }));
    expect(res.status).toBe(200);
    expect((await accountRow(id)).subscription_tier).toBe('free');
  });

  it('cancels a live subscription before granting lifetime', async () => {
    const { id, customer } = await createAccount({ tier: 'supporter', interval: 'monthly', subId: 'sub_replace' });
    retrieveSub.mockResolvedValueOnce(sub('sub_replace', customer, 'active') as never);
    cancelSub.mockResolvedValueOnce(sub('sub_replace', customer, 'canceled') as never);
    await sendEvent('checkout.session.completed', checkoutSession(customer));
    expect(cancelSub).toHaveBeenCalledWith('sub_replace');
    expect(await accountRow(id)).toMatchObject({ subscription_interval: 'lifetime', stripe_subscription_id: null });
  });

  it('treats a subscription Stripe no longer has as already cancelled', async () => {
    const { id, customer } = await createAccount({ tier: 'supporter', interval: 'monthly', subId: 'sub_gone' });
    retrieveSub.mockRejectedValueOnce(
      new Stripe.errors.StripeInvalidRequestError({
        type: 'invalid_request_error',
        code: 'resource_missing',
        message: 'No such subscription',
      } as never),
    );
    const res = await sendEvent('checkout.session.completed', checkoutSession(customer));
    expect(res.status).toBe(200);
    expect(cancelSub).not.toHaveBeenCalled();
    expect((await accountRow(id)).subscription_interval).toBe('lifetime');
  });
});

describe.skipIf(!WEBHOOK_SECRET)('refunds and disputes', () => {
  async function lifetime(pi: string) {
    return createAccount({ tier: 'supporter', interval: 'lifetime', paymentIntent: pi });
  }

  it('a full refund revokes lifetime and keeps the payment intent', async () => {
    const { id } = await lifetime('pi_refund');
    await sendEvent('charge.refunded', { id: 'ch_1', object: 'charge', refunded: true, payment_intent: 'pi_refund' });
    expect(await accountRow(id)).toMatchObject({
      subscription_tier: 'free',
      subscription_interval: null,
      stripe_lifetime_payment_intent: 'pi_refund',
    });
  });

  it('a partial refund keeps lifetime', async () => {
    const { id } = await lifetime('pi_partial');
    await sendEvent('charge.refunded', { id: 'ch_2', object: 'charge', refunded: false, payment_intent: 'pi_partial' });
    expect((await accountRow(id)).subscription_interval).toBe('lifetime');
  });

  it('a new dispute revokes lifetime, and a won dispute restores it', async () => {
    const { id } = await lifetime('pi_dispute');
    await sendEvent('charge.dispute.created', { id: 'dp_1', object: 'dispute', status: 'needs_response', payment_intent: 'pi_dispute' });
    expect((await accountRow(id)).subscription_tier).toBe('free');

    await sendEvent('charge.dispute.closed', { id: 'dp_1', object: 'dispute', status: 'won', payment_intent: 'pi_dispute' });
    expect(await accountRow(id)).toMatchObject({ subscription_tier: 'supporter', subscription_interval: 'lifetime' });
  });

  it('an inquiry revokes lifetime, and closing it without a chargeback restores it', async () => {
    const { id } = await lifetime('pi_inquiry');
    await sendEvent('charge.dispute.created', { id: 'dp_3', object: 'dispute', status: 'warning_needs_response', payment_intent: 'pi_inquiry' });
    expect((await accountRow(id)).subscription_tier).toBe('free');

    await sendEvent('charge.dispute.closed', { id: 'dp_3', object: 'dispute', status: 'warning_closed', payment_intent: 'pi_inquiry' });
    expect(await accountRow(id)).toMatchObject({ subscription_tier: 'supporter', subscription_interval: 'lifetime' });
  });

  it('a lost dispute keeps access revoked', async () => {
    const { id } = await lifetime('pi_lost');
    await sendEvent('charge.dispute.created', { id: 'dp_2', object: 'dispute', status: 'needs_response', payment_intent: 'pi_lost' });
    await sendEvent('charge.dispute.closed', { id: 'dp_2', object: 'dispute', status: 'lost', payment_intent: 'pi_lost' });
    expect((await accountRow(id)).subscription_tier).toBe('free');
  });

  it('ignores a refund for a payment that is not a stored lifetime purchase', async () => {
    const { id } = await lifetime('pi_mine');
    const res = await sendEvent('charge.refunded', { id: 'ch_3', object: 'charge', refunded: true, payment_intent: 'pi_someone_else' });
    expect(res.status).toBe(200);
    expect((await accountRow(id)).subscription_interval).toBe('lifetime');
  });
});

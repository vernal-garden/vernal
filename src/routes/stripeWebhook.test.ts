import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi, type MockInstance } from 'vitest';
import request from 'supertest';
import { Pool, type PoolClient } from 'pg';
import Stripe from 'stripe';
import { gzipSync } from 'zlib';
import app from '../index';
import { getStripe } from '../lib/stripe';
import { logger } from '../lib/logger';
import * as mailer from '../lib/mailer';
import * as ownerAlerts from '../lib/ownerAlerts';

vi.mock('../lib/mailer', () => ({ sendMail: vi.fn().mockResolvedValue(undefined) }));
const sendMailMock = vi.mocked(mailer.sendMail);

// The real recordOwnerEvent, wrapped so a test can make the apply step fail right after it.
vi.mock('../lib/ownerAlerts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/ownerAlerts')>();
  return { ...actual, recordOwnerEvent: vi.fn(actual.recordOwnerEvent) };
});

const appStripe = getStripe();

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL must be set to run tests');
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

const pool = new Pool({ connectionString: url });
const signer = new Stripe(process.env.STRIPE_SECRET_KEY!);

const retrieveSub = vi.spyOn(appStripe.subscriptions, 'retrieve');
const cancelSub = vi.spyOn(appStripe.subscriptions, 'cancel');
const listSubs = vi.spyOn(appStripe.subscriptions, 'list');
const retrievePi = vi.spyOn(appStripe.paymentIntents, 'retrieve');
const listInvoicePayments = vi.spyOn(appStripe.invoicePayments, 'list');
const createRefund = vi.spyOn(appStripe.refunds, 'create');

// A payment intent whose latest charge was paid by a card from `country`.
function intent(country: string | null) {
  return {
    id: 'pi_card',
    object: 'payment_intent',
    latest_charge: { id: 'ch_card', object: 'charge', payment_method_details: { card: { country } } },
  };
}

function invoicePayments(paymentIntent: string) {
  return {
    data: [
      { id: 'inpay_1', object: 'invoice_payment', status: 'paid', payment: { type: 'payment_intent', payment_intent: paymentIntent } },
    ],
  };
}

let seq = 0;

interface AccountFields {
  tier?: 'free' | 'supporter';
  interval?: string | null;
  subId?: string | null;
  paymentIntent?: string | null;
}

// Each account gets its own customer id; returns both.
async function createAccount(fields: AccountFields = {}): Promise<{ id: number; customer: string; email: string }> {
  seq += 1;
  const customer = `cus_wh_${seq}`;
  const email = `wh-${seq}@example.com`;
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO accounts (email, password_hash, zone, zone_location_label, email_verified,
                           stripe_customer_id, subscription_tier, subscription_interval,
                           stripe_subscription_id, stripe_lifetime_payment_intent)
     VALUES ($1, 'x', '7b', 'Test City', true, $2, $3, $4, $5, $6) RETURNING id`,
    [
      email,
      customer,
      fields.tier ?? 'free',
      fields.interval ?? null,
      fields.subId ?? null,
      fields.paymentIntent ?? null,
    ],
  );
  return { id: rows[0].id, customer, email };
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
  await pool.query(
    'TRUNCATE accounts, guest_sessions, password_reset_tokens, stripe_events, owner_events, checkout_country_checks RESTART IDENTITY CASCADE',
  );
});
beforeEach(() => {
  retrieveSub.mockReset();
  cancelSub.mockReset();
  listSubs.mockReset();
  retrieveSub.mockRejectedValue(new Error('unexpected subscriptions.retrieve'));
  cancelSub.mockRejectedValue(new Error('unexpected subscriptions.cancel'));
  listSubs.mockResolvedValue({ data: [] } as never);
  retrievePi.mockReset();
  listInvoicePayments.mockReset();
  createRefund.mockReset();
  // Checkouts pass the country check (US card) unless a test says otherwise.
  retrievePi.mockResolvedValue(intent('US') as never);
  listInvoicePayments.mockResolvedValue(invoicePayments('pi_invoice') as never);
  createRefund.mockRejectedValue(new Error('unexpected refunds.create'));
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

  it('answers a bad signature with a fixed message', async () => {
    const res = await request(app)
      .post('/api/webhooks/stripe')
      .set('stripe-signature', 'bad-sig')
      .set('Content-Type', 'application/json')
      .send('{}');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid signature' });
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
    invoice: `in_${seq}`,
    // US-only checkout: a US billing address, and (by default) a US card.
    customer_details: { address: { country: 'US' } },
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

describe.skipIf(!WEBHOOK_SECRET)('owner events and alerts', () => {
  const OWNER = 'owner-alerts@example.test';
  // Pre-existing, out of this phase's scope: the only log line allowed to carry a Stripe id.
  const REVOKE_LOG = 'Lifetime access revoked after a refund or dispute';
  let logged: MockInstance[] = [];

  beforeAll(async () => {
    // A distinctive id, so a leak can't hide behind an amount or a timestamp.
    await pool.query("SELECT setval(pg_get_serial_sequence('accounts', 'id'), GREATEST(987650, (SELECT MAX(id) FROM accounts)))");
  });
  beforeEach(async () => {
    process.env.ALERT_EMAIL_TO = OWNER;
    await pool.query('TRUNCATE owner_events RESTART IDENTITY');
    sendMailMock.mockClear();
    logged = [vi.spyOn(logger, 'info'), vi.spyOn(logger, 'warn'), vi.spyOn(logger, 'error')];
  });
  afterEach(() => {
    process.env.ALERT_EMAIL_TO = '';
    for (const spy of logged) spy.mockRestore();
  });

  async function kinds(): Promise<string[]> {
    return (await pool.query<{ kind: string }>('SELECT kind FROM owner_events ORDER BY id')).rows.map((r) => r.kind);
  }

  function alerts(): { subject: string; text: string }[] {
    return sendMailMock.mock.calls.filter(([m]) => m.to === OWNER).map(([m]) => m as { subject: string; text: string });
  }

  function firstLines(n: number): string[] {
    return alerts()[0].text.split('\n\n').slice(0, n);
  }

  async function noAlert() {
    await new Promise((r) => setTimeout(r, 100));
    expect(alerts()).toHaveLength(0);
  }

  // The revoke warning is the pre-existing line; it is checked, then left out of the leak check.
  function revokeLogs(): unknown[][] {
    return logged[1].mock.calls.filter(([msg]) => msg === REVOKE_LOG);
  }

  async function expectNoLeak(account: { id: number; customer: string; email: string }, stripeIds: string[]) {
    await expectNoSecrets([account.email, String(account.id), account.customer, ...stripeIds]);
  }

  async function expectNoSecrets(secrets: string[]) {
    const mailText = JSON.stringify(sendMailMock.mock.calls);
    const rowsText = JSON.stringify((await pool.query('SELECT * FROM owner_events')).rows);
    const logText = JSON.stringify(logged.flatMap((spy) => spy.mock.calls.filter(([msg]) => msg !== REVOKE_LOG)));
    for (const text of [mailText, rowsText, logText]) {
      for (const secret of secrets) expect(text).not.toContain(secret);
    }
  }

  it('a subscription checkout records subscription_started and alerts with plan, interval and amount', async () => {
    const account = await createAccount();
    retrieveSub.mockResolvedValueOnce(sub('sub_start_1', account.customer) as never);
    const session = checkoutSession(account.customer, {
      mode: 'subscription',
      subscription: 'sub_start_1',
      payment_intent: null,
      amount_total: 500,
      currency: 'usd',
    });
    const res = await sendEvent('checkout.session.completed', session, 'evt_start_1');
    expect(res.status).toBe(200);
    expect(retrieveSub).toHaveBeenCalledWith('sub_start_1');
    expect(await kinds()).toEqual(['subscription_started']);
    await vi.waitFor(() => expect(alerts()).toHaveLength(1));
    expect(alerts()[0].subject).toBe('[Vernal app] New Supporter subscription');
    expect(firstLines(1)).toEqual(['Supporter, monthly, $5.00.']);
    expect(alerts()[0].text).toMatch(/Open users: \S+\/admin\/users$/);
    // The account itself is left to the customer.subscription.* events.
    expect((await accountRow(account.id)).subscription_tier).toBe('free');
    await expectNoLeak(account, ['sub_start_1', session.id, 'evt_start_1']);
  });

  it('a delayed subscription payment that succeeds counts too', async () => {
    const account = await createAccount();
    retrieveSub.mockResolvedValueOnce(
      sub('sub_start_2', account.customer, 'active', {
        items: { data: [{ current_period_end: 1893456000, price: { recurring: { interval: 'year' } } }] },
      }) as never,
    );
    const session = checkoutSession(account.customer, {
      mode: 'subscription',
      subscription: 'sub_start_2',
      payment_intent: null,
      amount_total: 5000,
      currency: 'usd',
    });
    await sendEvent('checkout.session.async_payment_succeeded', session, 'evt_start_2');
    expect(await kinds()).toEqual(['subscription_started']);
    await vi.waitFor(() => expect(alerts()).toHaveLength(1));
    expect(firstLines(1)).toEqual(['Supporter, yearly, $50.00.']);
    await expectNoLeak(account, ['sub_start_2', session.id, 'evt_start_2']);
  });

  it('a failed subscription lookup still records, without the interval or an id in the logs', async () => {
    const account = await createAccount();
    retrieveSub.mockRejectedValueOnce(new Error('Stripe down'));
    const session = checkoutSession(account.customer, {
      mode: 'subscription',
      subscription: 'sub_start_3',
      payment_intent: null,
      amount_total: 500,
      currency: 'usd',
    });
    const res = await sendEvent('checkout.session.completed', session, 'evt_start_3');
    expect(res.status).toBe(200);
    expect(await kinds()).toEqual(['subscription_started']);
    await vi.waitFor(() => expect(alerts()).toHaveLength(1));
    expect(firstLines(1)).toEqual(['Supporter, $5.00.']);
    const logText = JSON.stringify(logged.map((spy) => spy.mock.calls));
    for (const id of ['sub_start_3', account.customer, session.id]) expect(logText).not.toContain(id);
    await expectNoLeak(account, ['sub_start_3', session.id, 'evt_start_3']);
  });

  it('a subscription checkout for an unknown customer records nothing', async () => {
    retrieveSub.mockResolvedValueOnce(sub('sub_start_4', 'cus_nobody') as never);
    const session = checkoutSession('cus_nobody', { mode: 'subscription', subscription: 'sub_start_4', amount_total: 500, currency: 'usd' });
    expect((await sendEvent('checkout.session.completed', session)).status).toBe(200);
    expect(await kinds()).toEqual([]);
    await noAlert();
    await expectNoSecrets(['cus_nobody', 'sub_start_4', session.id]);
  });

  it('a no_payment_required subscription checkout counts, with a zero amount', async () => {
    const account = await createAccount();
    // Retrieved twice: by the country check (no default payment method, so the
    // US address alone decides), then for the alert's interval.
    retrieveSub.mockResolvedValue(sub('sub_start_5', account.customer) as never);
    const session = checkoutSession(account.customer, {
      mode: 'subscription',
      payment_status: 'no_payment_required',
      subscription: 'sub_start_5',
      payment_intent: null,
      amount_total: 0,
      currency: 'usd',
    });
    expect((await sendEvent('checkout.session.completed', session, 'evt_start_5')).status).toBe(200);
    expect(await kinds()).toEqual(['subscription_started']);
    await vi.waitFor(() => expect(alerts()).toHaveLength(1));
    expect(firstLines(1)).toEqual(['Supporter, monthly, $0.00.']);
    await expectNoLeak(account, ['sub_start_5', session.id, 'evt_start_5']);
  });

  it('a subscription checkout without an amount leaves it out of the line', async () => {
    const account = await createAccount();
    retrieveSub.mockResolvedValueOnce(sub('sub_start_6', account.customer) as never);
    const session = checkoutSession(account.customer, { mode: 'subscription', subscription: 'sub_start_6', payment_intent: null });
    await sendEvent('checkout.session.completed', session, 'evt_start_6');
    expect(await kinds()).toEqual(['subscription_started']);
    await vi.waitFor(() => expect(alerts()).toHaveLength(1));
    expect(firstLines(1)).toEqual(['Supporter, monthly.']);
    await expectNoLeak(account, ['sub_start_6', session.id, 'evt_start_6']);
  });

  it('an unpaid subscription checkout waits for the delayed payment, which counts once', async () => {
    const account = await createAccount();
    const session = checkoutSession(account.customer, {
      mode: 'subscription',
      payment_status: 'unpaid',
      subscription: 'sub_start_7',
      payment_intent: null,
      amount_total: 500,
      currency: 'usd',
    });
    expect((await sendEvent('checkout.session.completed', session, 'evt_start_7a')).status).toBe(200);
    expect(await kinds()).toEqual([]);
    await noAlert();

    retrieveSub.mockResolvedValueOnce(sub('sub_start_7', account.customer) as never);
    const paid = { ...session, payment_status: 'paid' };
    expect((await sendEvent('checkout.session.async_payment_succeeded', paid, 'evt_start_7b')).status).toBe(200);
    expect(await kinds()).toEqual(['subscription_started']);
    await vi.waitFor(() => expect(alerts()).toHaveLength(1));
    expect(firstLines(1)).toEqual(['Supporter, monthly, $5.00.']);
    await expectNoLeak(account, ['sub_start_7', session.id, 'evt_start_7a', 'evt_start_7b']);
  });

  it('a setup-mode checkout records nothing', async () => {
    const account = await createAccount();
    const session = checkoutSession(account.customer, { mode: 'setup', payment_status: 'no_payment_required', payment_intent: null });
    expect((await sendEvent('checkout.session.completed', session, 'evt_setup_1')).status).toBe(200);
    expect(await kinds()).toEqual([]);
    expect((await accountRow(account.id)).subscription_tier).toBe('free');
    await noAlert();
    await expectNoLeak(account, [session.id, 'evt_setup_1']);
  });

  it('a subscription checkout on a lifetime account records nothing', async () => {
    const account = await createAccount({ tier: 'supporter', interval: 'lifetime', paymentIntent: 'pi_start_8' });
    retrieveSub.mockResolvedValueOnce(sub('sub_start_8', account.customer) as never);
    const session = checkoutSession(account.customer, {
      mode: 'subscription',
      subscription: 'sub_start_8',
      payment_intent: null,
      amount_total: 500,
      currency: 'usd',
    });
    expect((await sendEvent('checkout.session.completed', session, 'evt_start_8')).status).toBe(200);
    expect(await kinds()).toEqual([]);
    await noAlert();
    await expectNoLeak(account, ['sub_start_8', 'pi_start_8', session.id, 'evt_start_8']);
  });

  it('a lifetime checkout records lifetime_purchased and alerts with the amount', async () => {
    const account = await createAccount();
    const session = checkoutSession(account.customer, { payment_intent: 'pi_life_1', amount_total: 4000, currency: 'usd' });
    await sendEvent('checkout.session.completed', session, 'evt_life_1');
    expect(await kinds()).toEqual(['lifetime_purchased']);
    await vi.waitFor(() => expect(alerts()).toHaveLength(1));
    expect(alerts()[0].subject).toBe('[Vernal app] New lifetime purchase');
    expect(firstLines(1)).toEqual(['Lifetime, $40.00.']);
    await expectNoLeak(account, ['pi_life_1', session.id, 'evt_life_1']);
  });

  it('a lifetime checkout without an amount leaves it out of the line', async () => {
    const account = await createAccount();
    const session = checkoutSession(account.customer, { payment_intent: 'pi_life_2' });
    await sendEvent('checkout.session.completed', session, 'evt_life_2');
    expect(await kinds()).toEqual(['lifetime_purchased']);
    await vi.waitFor(() => expect(alerts()).toHaveLength(1));
    expect(firstLines(1)).toEqual(['Lifetime.']);
    await expectNoLeak(account, ['pi_life_2', session.id, 'evt_life_2']);
  });

  it('a lifetime checkout that matches no account records nothing', async () => {
    const session = checkoutSession('cus_nobody', { amount_total: 4000, currency: 'usd' });
    expect((await sendEvent('checkout.session.completed', session)).status).toBe(200);
    expect(await kinds()).toEqual([]);
    await noAlert();
    await expectNoSecrets(['cus_nobody', session.id, session.payment_intent]);
  });

  it('a full refund of a lifetime payment records refund and alerts with the amount', async () => {
    const account = await createAccount({ tier: 'supporter', interval: 'lifetime', paymentIntent: 'pi_ref_1' });
    const charge = { id: 'ch_ref_1', object: 'charge', refunded: true, payment_intent: 'pi_ref_1', amount_refunded: 4000, currency: 'usd' };
    await sendEvent('charge.refunded', charge, 'evt_ref_1');
    expect(await kinds()).toEqual(['refund']);
    await vi.waitFor(() => expect(alerts()).toHaveLength(1));
    expect(alerts()[0].subject).toBe('[Vernal app] A lifetime payment was refunded');
    expect(firstLines(1)).toEqual(['$40.00 refunded. Lifetime access was revoked automatically.']);
    expect(revokeLogs()).toEqual([[REVOKE_LOG, { paymentIntent: 'pi_ref_1' }]]);
    await expectNoLeak(account, ['pi_ref_1', 'ch_ref_1', 'evt_ref_1']);
  });

  it('a refund without an amount says so without guessing', async () => {
    const account = await createAccount({ tier: 'supporter', interval: 'lifetime', paymentIntent: 'pi_ref_2' });
    await sendEvent('charge.refunded', { id: 'ch_ref_2', object: 'charge', refunded: true, payment_intent: 'pi_ref_2' }, 'evt_ref_2');
    expect(await kinds()).toEqual(['refund']);
    await vi.waitFor(() => expect(alerts()).toHaveLength(1));
    expect(firstLines(1)).toEqual(['A payment was refunded. Lifetime access was revoked automatically.']);
    await expectNoLeak(account, ['pi_ref_2', 'ch_ref_2', 'evt_ref_2']);
  });

  it('a full refund of a non-lifetime charge records nothing and alerts nothing', async () => {
    const account = await createAccount({ tier: 'supporter', interval: 'monthly', subId: 'sub_ref_3' });
    const charge = { id: 'ch_ref_3', object: 'charge', refunded: true, payment_intent: 'pi_ref_3', amount_refunded: 500, currency: 'usd' };
    expect((await sendEvent('charge.refunded', charge, 'evt_ref_3')).status).toBe(200);
    expect(await kinds()).toEqual([]);
    await noAlert();
    expect(revokeLogs()).toEqual([]);
    await expectNoLeak(account, ['pi_ref_3', 'ch_ref_3', 'evt_ref_3', 'sub_ref_3']);
  });

  it('a dispute on a lifetime payment records dispute and says access was revoked', async () => {
    const account = await createAccount({ tier: 'supporter', interval: 'lifetime', paymentIntent: 'pi_dis_1' });
    const dispute = {
      id: 'dp_dis_1', object: 'dispute', status: 'needs_response', charge: 'ch_dis_1',
      payment_intent: 'pi_dis_1', amount: 4000, currency: 'usd',
    };
    await sendEvent('charge.dispute.created', dispute, 'evt_dis_1');
    expect(await kinds()).toEqual(['dispute']);
    await vi.waitFor(() => expect(alerts()).toHaveLength(1));
    expect(alerts()[0].subject).toBe('[Vernal app] A payment was disputed');
    expect(firstLines(2)).toEqual([
      '$40.00 disputed. Lifetime access was revoked automatically.',
      'Stripe sets a deadline to respond. Answer it in the Stripe dashboard.',
    ]);
    expect(revokeLogs()).toEqual([[REVOKE_LOG, { paymentIntent: 'pi_dis_1' }]]);
    await expectNoLeak(account, ['pi_dis_1', 'ch_dis_1', 'dp_dis_1', 'evt_dis_1']);
  });

  it('a dispute on a non-lifetime charge still records and alerts, without the revoked sentence', async () => {
    const account = await createAccount({ tier: 'supporter', interval: 'monthly', subId: 'sub_dis_2' });
    const dispute = {
      id: 'dp_dis_2', object: 'dispute', status: 'needs_response', charge: 'ch_dis_2',
      payment_intent: 'pi_dis_2', amount: 500, currency: 'usd',
    };
    await sendEvent('charge.dispute.created', dispute, 'evt_dis_2');
    expect(await kinds()).toEqual(['dispute']);
    await vi.waitFor(() => expect(alerts()).toHaveLength(1));
    expect(firstLines(2)).toEqual([
      '$5.00 disputed.',
      'Stripe sets a deadline to respond. Answer it in the Stripe dashboard.',
    ]);
    expect(revokeLogs()).toEqual([]);
    expect((await accountRow(account.id)).subscription_tier).toBe('supporter');
    await expectNoLeak(account, ['pi_dis_2', 'ch_dis_2', 'dp_dis_2', 'evt_dis_2', 'sub_dis_2']);
  });

  it('a dispute with no payment intent or amount still records and alerts', async () => {
    const account = await createAccount();
    await sendEvent('charge.dispute.created', { id: 'dp_dis_3', object: 'dispute', status: 'needs_response', charge: 'ch_dis_3' }, 'evt_dis_3');
    expect(await kinds()).toEqual(['dispute']);
    await vi.waitFor(() => expect(alerts()).toHaveLength(1));
    expect(firstLines(1)).toEqual(['A payment was disputed.']);
    await expectNoLeak(account, ['ch_dis_3', 'dp_dis_3', 'evt_dis_3']);
  });

  it('a cancel at period end counts once, and the later deleted event does not count again', async () => {
    const account = await createAccount({ tier: 'supporter', interval: 'monthly', subId: 'sub_can_1' });
    const cancelling = sub('sub_can_1', account.customer, 'active', { cancel_at_period_end: true, cancel_at: 1893456000 });
    retrieveSub.mockResolvedValueOnce(cancelling as never);
    await sendEvent('customer.subscription.updated', cancelling, 'evt_can_1');
    expect(await kinds()).toEqual(['subscription_cancelled']);

    retrieveSub.mockResolvedValueOnce(cancelling as never);
    await sendEvent('customer.subscription.updated', cancelling, 'evt_can_2');
    expect(await kinds()).toEqual(['subscription_cancelled']);

    retrieveSub.mockResolvedValueOnce(sub('sub_can_1', account.customer, 'canceled') as never);
    await sendEvent('customer.subscription.deleted', sub('sub_can_1', account.customer, 'canceled'), 'evt_can_3');
    expect((await accountRow(account.id)).subscription_tier).toBe('free');
    expect(await kinds()).toEqual(['subscription_cancelled']);
    await noAlert();
    await expectNoLeak(account, ['sub_can_1', 'evt_can_1', 'evt_can_2', 'evt_can_3']);
  });

  it('an immediate cancel counts once when the deleted event downgrades the account', async () => {
    const account = await createAccount({ tier: 'supporter', interval: 'monthly', subId: 'sub_can_2' });
    retrieveSub.mockResolvedValueOnce(sub('sub_can_2', account.customer, 'canceled') as never);
    await sendEvent('customer.subscription.deleted', sub('sub_can_2', account.customer, 'canceled'), 'evt_can_4');
    expect((await accountRow(account.id)).subscription_tier).toBe('free');
    expect(await kinds()).toEqual(['subscription_cancelled']);

    // A second deleted event finds the account already free and counts nothing.
    retrieveSub.mockResolvedValueOnce(sub('sub_can_2', account.customer, 'canceled') as never);
    await sendEvent('customer.subscription.deleted', sub('sub_can_2', account.customer, 'canceled'), 'evt_can_5');
    expect(await kinds()).toEqual(['subscription_cancelled']);
    await noAlert();
    await expectNoLeak(account, ['sub_can_2', 'evt_can_4', 'evt_can_5']);
  });

  it('the same event delivered twice records once and alerts once', async () => {
    const account = await createAccount();
    const session = checkoutSession(account.customer, { payment_intent: 'pi_twice', amount_total: 4000, currency: 'usd' });
    expect((await sendEvent('checkout.session.completed', session, 'evt_twice')).status).toBe(200);
    expect((await sendEvent('checkout.session.completed', session, 'evt_twice')).status).toBe(200);
    expect(await kinds()).toEqual(['lifetime_purchased']);
    await vi.waitFor(() => expect(alerts()).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 100));
    expect(alerts()).toHaveLength(1);
    await expectNoLeak(account, ['pi_twice', session.id, 'evt_twice']);
  });

  it('a rolled-back event records nothing, alerts nothing and returns 500', async () => {
    const account = await createAccount();
    const actual = await vi.importActual<typeof import('../lib/ownerAlerts')>('../lib/ownerAlerts');
    vi.mocked(ownerAlerts.recordOwnerEvent).mockImplementationOnce(async (kind, client?: PoolClient) => {
      await actual.recordOwnerEvent(kind, client);
      throw new Error('injected failure');
    });
    const session = checkoutSession(account.customer, { payment_intent: 'pi_rollback', amount_total: 4000, currency: 'usd' });
    vi.mocked(ownerAlerts.recordOwnerEvent).mockClear();
    const res = await sendEvent('checkout.session.completed', session, 'evt_rollback');
    expect(ownerAlerts.recordOwnerEvent).toHaveBeenCalledWith('lifetime_purchased', expect.anything());
    expect(res.status).toBe(500);
    expect(await kinds()).toEqual([]);
    expect((await accountRow(account.id)).subscription_tier).toBe('free');
    const { rowCount } = await pool.query("SELECT 1 FROM stripe_events WHERE event_id = 'evt_rollback'");
    expect(rowCount).toBe(0);
    await noAlert();
    await expectNoLeak(account, ['pi_rollback', session.id, 'evt_rollback']);
  });

  it('an event type the handler ignores records nothing', async () => {
    const account = await createAccount();
    expect((await sendEvent('customer.created', { id: account.customer }, 'evt_ignored')).status).toBe(200);
    expect((await sendEvent('checkout.session.completed', checkoutSession(account.customer, { payment_status: 'unpaid' }))).status).toBe(200);
    expect(await kinds()).toEqual([]);
    await noAlert();
    await expectNoLeak(account, ['evt_ignored']);
  });
});

describe.skipIf(!WEBHOOK_SECRET)('US-only checkout', () => {
  const OWNER = 'owner-alerts@example.test';
  const REFUNDED = 'Refunded: paid plans are US-only at launch.';
  const CANCELLED = 'Cancelled: paid plans are US-only at launch.';
  let warn: MockInstance;

  beforeEach(async () => {
    process.env.ALERT_EMAIL_TO = OWNER;
    await pool.query('TRUNCATE owner_events, checkout_country_checks RESTART IDENTITY');
    sendMailMock.mockClear();
    warn = vi.spyOn(logger, 'warn');
  });
  afterEach(() => {
    process.env.ALERT_EMAIL_TO = '';
    warn.mockRestore();
  });

  async function checks() {
    const { rows } = await pool.query<{ country: string | null; plan: string; check_kind: string }>(
      'SELECT country, plan, check_kind FROM checkout_country_checks ORDER BY id',
    );
    return rows.map((r) => [r.country, r.plan, r.check_kind]);
  }

  async function kinds(): Promise<string[]> {
    return (await pool.query<{ kind: string }>('SELECT kind FROM owner_events ORDER BY id')).rows.map((r) => r.kind);
  }

  function alerts(): { subject: string; text: string }[] {
    return sendMailMock.mock.calls.filter(([m]) => m.to === OWNER).map(([m]) => m as { subject: string; text: string });
  }

  function lines(n: number): string[] {
    return alerts()[0].text.split('\n\n').slice(0, n);
  }

  function lifetimeSession(customer: string, country: string, overrides: Record<string, unknown> = {}) {
    return checkoutSession(customer, {
      amount_total: 4000,
      currency: 'usd',
      customer_details: { address: { country } },
      ...overrides,
    });
  }

  function subscriptionSession(customer: string, subId: string, country: string, overrides: Record<string, unknown> = {}) {
    return checkoutSession(customer, {
      mode: 'subscription',
      subscription: subId,
      payment_intent: null,
      amount_total: 500,
      currency: 'usd',
      customer_details: { address: { country } },
      ...overrides,
    });
  }

  // A no_payment_required subscription, with its default payment method expanded.
  function freeSub(id: string, customer: string, cardCountry: string | null | undefined) {
    const method = cardCountry === undefined ? null : { id: 'pm_1', object: 'payment_method', card: { country: cardCountry } };
    return sub(id, customer, 'active', { default_payment_method: method });
  }

  it('a US address and US card: lifetime is granted, nothing refunded or recorded', async () => {
    const { id, customer } = await createAccount();
    const session = lifetimeSession(customer, 'US', { payment_intent: 'pi_us_1' });
    expect((await sendEvent('checkout.session.completed', session)).status).toBe(200);
    expect(retrievePi).toHaveBeenCalledWith('pi_us_1', { expand: ['latest_charge'] });
    expect(createRefund).not.toHaveBeenCalled();
    expect(await checks()).toEqual([]);
    expect(await accountRow(id)).toMatchObject({ subscription_interval: 'lifetime', stripe_lifetime_payment_intent: 'pi_us_1' });
  });

  it('a US address and US card on a subscription: subscription_started, no refund or cancel', async () => {
    const { customer } = await createAccount();
    retrieveSub.mockResolvedValueOnce(sub('sub_us_1', customer) as never);
    const session = subscriptionSession(customer, 'sub_us_1', 'US', { invoice: 'in_us_1' });
    expect((await sendEvent('checkout.session.completed', session)).status).toBe(200);
    expect(listInvoicePayments).toHaveBeenCalledWith({ invoice: 'in_us_1', limit: 10 });
    expect(retrievePi).toHaveBeenCalledWith('pi_invoice', { expand: ['latest_charge'] });
    expect(createRefund).not.toHaveBeenCalled();
    expect(cancelSub).not.toHaveBeenCalled();
    expect(await kinds()).toEqual(['subscription_started']);
    expect(await checks()).toEqual([]);
  });

  it('a US territory counts as US', async () => {
    const { id, customer } = await createAccount();
    retrievePi.mockResolvedValue(intent('PR') as never);
    await sendEvent('checkout.session.completed', lifetimeSession(customer, 'pr'));
    expect((await accountRow(id)).subscription_interval).toBe('lifetime');
    expect(await checks()).toEqual([]);
  });

  it('a GB card on a lifetime checkout is refunded, recorded and alerted, and grants nothing', async () => {
    const { id, customer } = await createAccount();
    retrievePi.mockResolvedValue(intent('GB') as never);
    createRefund.mockResolvedValue({ id: 're_1' } as never);
    const session = lifetimeSession(customer, 'US', { payment_intent: 'pi_gb_1' });
    expect((await sendEvent('checkout.session.completed', session)).status).toBe(200);
    expect(createRefund).toHaveBeenCalledTimes(1);
    expect(createRefund).toHaveBeenCalledWith({ payment_intent: 'pi_gb_1' }, { idempotencyKey: `country-refund-${session.id}` });
    expect(await accountRow(id)).toMatchObject({
      subscription_tier: 'free',
      subscription_interval: null,
      stripe_lifetime_payment_intent: null,
    });
    expect(await checks()).toEqual([['GB', 'lifetime', 'card_country']]);
    expect(await kinds()).toEqual([]);
    await vi.waitFor(() => expect(alerts()).toHaveLength(1));
    expect(alerts()[0].subject).toBe('[Vernal app] Checkout refused: outside the US');
    expect(lines(2)).toEqual(['Lifetime, GB, $40.00.', REFUNDED]);
    expect(alerts()[0].text).toMatch(/Open users: \S+\/admin\/users$/);
  });

  it('a FR billing address with a US card is refused on the address', async () => {
    const { id, customer } = await createAccount();
    createRefund.mockResolvedValue({ id: 're_2' } as never);
    const session = lifetimeSession(customer, 'FR', { payment_intent: 'pi_fr_1' });
    await sendEvent('checkout.session.completed', session);
    expect(createRefund).toHaveBeenCalledWith({ payment_intent: 'pi_fr_1' }, { idempotencyKey: `country-refund-${session.id}` });
    expect(await checks()).toEqual([['FR', 'lifetime', 'billing_address']]);
    expect((await accountRow(id)).subscription_tier).toBe('free');
  });

  it('the billing address wins when both the address and the card fail', async () => {
    const { customer } = await createAccount();
    retrievePi.mockResolvedValue(intent('GB') as never);
    createRefund.mockResolvedValue({ id: 're_3' } as never);
    await sendEvent('checkout.session.completed', lifetimeSession(customer, 'FR'));
    expect(await checks()).toEqual([['FR', 'lifetime', 'billing_address']]);
  });

  it('a paid checkout with no card country fails closed', async () => {
    const { id, customer } = await createAccount();
    retrievePi.mockResolvedValue(intent(null) as never);
    createRefund.mockResolvedValue({ id: 're_4' } as never);
    const session = lifetimeSession(customer, 'US');
    await sendEvent('checkout.session.completed', session);
    expect(createRefund).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('No card country on a paid checkout; refusing it', { sessionId: session.id });
    expect(await checks()).toEqual([[null, 'lifetime', 'card_country']]);
    expect((await accountRow(id)).subscription_tier).toBe('free');
    await vi.waitFor(() => expect(alerts()).toHaveLength(1));
    expect(lines(1)).toEqual(['Lifetime, country unknown, $40.00.']);
  });

  it('a charge Stripe has already refunded counts as refunded', async () => {
    const { customer } = await createAccount();
    retrievePi.mockResolvedValue(intent('GB') as never);
    createRefund.mockRejectedValue(
      new Stripe.errors.StripeInvalidRequestError({
        type: 'invalid_request_error',
        code: 'charge_already_refunded',
        message: 'Charge has already been refunded.',
      } as never),
    );
    expect((await sendEvent('checkout.session.completed', lifetimeSession(customer, 'US'))).status).toBe(200);
    expect(await checks()).toEqual([['GB', 'lifetime', 'card_country']]);
  });

  it('any other refund error fails the event so Stripe retries it', async () => {
    const { customer } = await createAccount();
    retrievePi.mockResolvedValue(intent('GB') as never);
    createRefund.mockRejectedValue(new Error('Stripe down'));
    const res = await sendEvent('checkout.session.completed', lifetimeSession(customer, 'US'), 'evt_refund_fail');
    expect(res.status).toBe(500);
    expect(await checks()).toEqual([]);
    const { rowCount } = await pool.query("SELECT 1 FROM stripe_events WHERE event_id = 'evt_refund_fail'");
    expect(rowCount).toBe(0);
  });

  it('a GB card on a paid subscription refunds the invoice payment and cancels the subscription', async () => {
    const { customer } = await createAccount();
    listInvoicePayments.mockResolvedValue(invoicePayments('pi_sub_gb') as never);
    retrievePi.mockResolvedValue(intent('GB') as never);
    retrieveSub.mockResolvedValue(sub('sub_gb_1', customer) as never);
    cancelSub.mockResolvedValue(sub('sub_gb_1', customer, 'canceled') as never);
    createRefund.mockResolvedValue({ id: 're_5' } as never);
    const session = subscriptionSession(customer, 'sub_gb_1', 'US', { invoice: 'in_gb_1', metadata: { plan: 'annual' } });
    expect((await sendEvent('checkout.session.completed', session)).status).toBe(200);
    expect(listInvoicePayments).toHaveBeenCalledWith({ invoice: 'in_gb_1', limit: 10 });
    expect(retrievePi).toHaveBeenCalledWith('pi_sub_gb', { expand: ['latest_charge'] });
    expect(createRefund).toHaveBeenCalledWith({ payment_intent: 'pi_sub_gb' }, { idempotencyKey: `country-refund-${session.id}` });
    expect(cancelSub).toHaveBeenCalledWith('sub_gb_1');
    expect(await kinds()).toEqual([]);
    expect(await checks()).toEqual([['GB', 'annual', 'card_country']]);
    await vi.waitFor(() => expect(alerts()).toHaveLength(1));
    expect(lines(2)).toEqual(['Annual, GB, $5.00.', REFUNDED]);
  });

  it('prefers the paid invoice payment over an earlier failed attempt', async () => {
    const { customer } = await createAccount();
    listInvoicePayments.mockResolvedValue({
      data: [
        { id: 'inpay_a', status: 'canceled', payment: { type: 'payment_intent', payment_intent: 'pi_failed' } },
        { id: 'inpay_b', status: 'paid', payment: { type: 'payment_intent', payment_intent: 'pi_good' } },
      ],
    } as never);
    retrieveSub.mockResolvedValueOnce(sub('sub_pref_1', customer) as never);
    await sendEvent('checkout.session.completed', subscriptionSession(customer, 'sub_pref_1', 'US'));
    expect(retrievePi).toHaveBeenCalledWith('pi_good', { expand: ['latest_charge'] });
    expect(await kinds()).toEqual(['subscription_started']);
  });

  it('a paid subscription with no payment found is cancelled and the alert asks for a manual refund', async () => {
    const { customer } = await createAccount();
    listInvoicePayments.mockResolvedValue({ data: [] } as never);
    retrieveSub.mockResolvedValue(sub('sub_nopay', customer) as never);
    cancelSub.mockResolvedValue(sub('sub_nopay', customer, 'canceled') as never);
    const session = subscriptionSession(customer, 'sub_nopay', 'US');
    expect((await sendEvent('checkout.session.completed', session)).status).toBe(200);
    expect(cancelSub).toHaveBeenCalledWith('sub_nopay');
    expect(createRefund).not.toHaveBeenCalled();
    expect(await checks()).toEqual([[null, 'monthly', 'card_country']]);
    await vi.waitFor(() => expect(alerts()).toHaveLength(1));
    expect(lines(2)).toEqual([
      'Monthly, country unknown, $5.00.',
      'Refund needed: no payment was found to refund automatically. Refund it in the Stripe dashboard.',
    ]);
    expect(alerts()[0].text).not.toContain('Refunded:');
  });

  it('a refused subscription whose created event landed first sets the account back to free', async () => {
    const { id, customer } = await createAccount();
    retrieveSub.mockResolvedValueOnce(sub('sub_first', customer) as never);
    await sendEvent('customer.subscription.created', sub('sub_first', customer));
    expect(await accountRow(id)).toMatchObject({ subscription_tier: 'supporter', stripe_subscription_id: 'sub_first' });

    retrievePi.mockResolvedValue(intent('GB') as never);
    retrieveSub.mockResolvedValue(sub('sub_first', customer) as never);
    cancelSub.mockResolvedValue(sub('sub_first', customer, 'canceled') as never);
    createRefund.mockResolvedValue({ id: 're_6' } as never);
    expect((await sendEvent('checkout.session.completed', subscriptionSession(customer, 'sub_first', 'US'))).status).toBe(200);
    expect(cancelSub).toHaveBeenCalledWith('sub_first');
    expect(await accountRow(id)).toMatchObject({ subscription_tier: 'free', stripe_subscription_id: null });
    // No plan in the metadata: read from the subscription's price.
    expect(await checks()).toEqual([['GB', 'monthly', 'card_country']]);

    // The cancel's own deleted event leaves it free and counts nothing.
    retrieveSub.mockResolvedValue(sub('sub_first', customer, 'canceled') as never);
    await sendEvent('customer.subscription.deleted', sub('sub_first', customer, 'canceled'));
    expect(await accountRow(id)).toMatchObject({ subscription_tier: 'free', stripe_subscription_id: null });
    expect(await kinds()).toEqual([]);
  });

  it('a refused subscription whose created event lands later stays free', async () => {
    const { id, customer } = await createAccount();
    retrievePi.mockResolvedValue(intent('GB') as never);
    retrieveSub.mockResolvedValue(sub('sub_late', customer) as never);
    cancelSub.mockResolvedValue(sub('sub_late', customer, 'canceled') as never);
    createRefund.mockResolvedValue({ id: 're_7' } as never);
    await sendEvent('checkout.session.completed', subscriptionSession(customer, 'sub_late', 'US'));
    expect((await accountRow(id)).subscription_tier).toBe('free');

    // planSubscription works from the live (cancelled) state.
    retrieveSub.mockResolvedValue(sub('sub_late', customer, 'canceled') as never);
    await sendEvent('customer.subscription.created', sub('sub_late', customer));
    expect((await accountRow(id)).subscription_tier).toBe('free');
  });

  it('a refused subscription only resets the account holding that subscription', async () => {
    const other = await createAccount({ tier: 'supporter', interval: 'monthly', subId: 'sub_keep_other' });
    const { customer } = await createAccount();
    retrievePi.mockResolvedValue(intent('GB') as never);
    retrieveSub.mockResolvedValue(sub('sub_refused_x', customer) as never);
    cancelSub.mockResolvedValue(sub('sub_refused_x', customer, 'canceled') as never);
    createRefund.mockResolvedValue({ id: 're_8' } as never);
    await sendEvent('checkout.session.completed', subscriptionSession(customer, 'sub_refused_x', 'US'));
    expect(await accountRow(other.id)).toMatchObject({ subscription_tier: 'supporter', stripe_subscription_id: 'sub_keep_other' });
  });

  it('no_payment_required with a GB default card: cancelled, not refunded, alerted', async () => {
    const { customer } = await createAccount();
    retrieveSub.mockResolvedValue(freeSub('sub_free_gb', customer, 'GB') as never);
    cancelSub.mockResolvedValue(sub('sub_free_gb', customer, 'canceled') as never);
    const session = subscriptionSession(customer, 'sub_free_gb', 'US', { payment_status: 'no_payment_required', amount_total: 0 });
    expect((await sendEvent('checkout.session.completed', session)).status).toBe(200);
    expect(retrieveSub).toHaveBeenCalledWith('sub_free_gb', { expand: ['default_payment_method'] });
    expect(listInvoicePayments).not.toHaveBeenCalled();
    expect(retrievePi).not.toHaveBeenCalled();
    expect(createRefund).not.toHaveBeenCalled();
    expect(cancelSub).toHaveBeenCalledWith('sub_free_gb');
    expect(await kinds()).toEqual([]);
    expect(await checks()).toEqual([['GB', 'monthly', 'card_country']]);
    await vi.waitFor(() => expect(alerts()).toHaveLength(1));
    expect(lines(2)).toEqual(['Monthly, GB, $0.00.', CANCELLED]);
  });

  it('no_payment_required with no default card and a US address is allowed', async () => {
    const { customer } = await createAccount();
    retrieveSub.mockResolvedValue(freeSub('sub_free_us', customer, undefined) as never);
    const session = subscriptionSession(customer, 'sub_free_us', 'US', { payment_status: 'no_payment_required', amount_total: 0 });
    await sendEvent('checkout.session.completed', session);
    expect(cancelSub).not.toHaveBeenCalled();
    expect(createRefund).not.toHaveBeenCalled();
    expect(await kinds()).toEqual(['subscription_started']);
    expect(await checks()).toEqual([]);
  });

  it('no_payment_required with no default card and a FR address is cancelled on the address', async () => {
    const { customer } = await createAccount();
    retrieveSub.mockResolvedValue(freeSub('sub_free_fr', customer, undefined) as never);
    cancelSub.mockResolvedValue(sub('sub_free_fr', customer, 'canceled') as never);
    const session = subscriptionSession(customer, 'sub_free_fr', 'FR', { payment_status: 'no_payment_required', amount_total: 0 });
    await sendEvent('checkout.session.completed', session);
    expect(cancelSub).toHaveBeenCalledWith('sub_free_fr');
    expect(createRefund).not.toHaveBeenCalled();
    expect(await checks()).toEqual([['FR', 'monthly', 'billing_address']]);
    await vi.waitFor(() => expect(alerts()).toHaveLength(1));
    expect(lines(2)).toEqual(['Monthly, FR, $0.00.', CANCELLED]);
  });

  it('a delayed lifetime payment from outside the US is refused too', async () => {
    const { id, customer } = await createAccount();
    retrievePi.mockResolvedValue(intent('GB') as never);
    createRefund.mockResolvedValue({ id: 're_9' } as never);
    await sendEvent('checkout.session.async_payment_succeeded', lifetimeSession(customer, 'US'));
    expect(createRefund).toHaveBeenCalledTimes(1);
    expect((await accountRow(id)).subscription_tier).toBe('free');
    expect(await checks()).toEqual([['GB', 'lifetime', 'card_country']]);
  });

  it('the same refused event delivered twice refunds, records and alerts once', async () => {
    const { customer } = await createAccount();
    retrievePi.mockResolvedValue(intent('GB') as never);
    createRefund.mockResolvedValue({ id: 're_10' } as never);
    const session = lifetimeSession(customer, 'US');
    expect((await sendEvent('checkout.session.completed', session, 'evt_refused_twice')).status).toBe(200);
    expect((await sendEvent('checkout.session.completed', session, 'evt_refused_twice')).status).toBe(200);
    expect(createRefund).toHaveBeenCalledTimes(1);
    expect(await checks()).toEqual([['GB', 'lifetime', 'card_country']]);
    await vi.waitFor(() => expect(alerts()).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 100));
    expect(alerts()).toHaveLength(1);
  });

  it('a refused lifetime purchase does not cancel the live subscription', async () => {
    const { id, customer } = await createAccount({ tier: 'supporter', interval: 'monthly', subId: 'sub_live_keep' });
    retrievePi.mockResolvedValue(intent('GB') as never);
    createRefund.mockResolvedValue({ id: 're_11' } as never);
    expect((await sendEvent('checkout.session.completed', lifetimeSession(customer, 'US'))).status).toBe(200);
    expect(cancelSub).not.toHaveBeenCalled();
    expect(retrieveSub).not.toHaveBeenCalled();
    expect(await accountRow(id)).toMatchObject({
      subscription_tier: 'supporter',
      subscription_interval: 'monthly',
      stripe_subscription_id: 'sub_live_keep',
    });
  });

  it('the refund then arriving as charge.refunded changes nothing on a refused lifetime purchase', async () => {
    const { id, customer } = await createAccount();
    retrievePi.mockResolvedValue(intent('GB') as never);
    createRefund.mockResolvedValue({ id: 're_12' } as never);
    await sendEvent('checkout.session.completed', lifetimeSession(customer, 'US', { payment_intent: 'pi_refused_life' }));
    await sendEvent('charge.refunded', { id: 'ch_refused', object: 'charge', refunded: true, payment_intent: 'pi_refused_life' });
    expect(await accountRow(id)).toMatchObject({ subscription_tier: 'free', stripe_lifetime_payment_intent: null });
    expect(await kinds()).toEqual([]);
  });
});

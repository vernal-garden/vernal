import type { Request, Response } from 'express';
import type { PoolClient } from 'pg';
import type Stripe from 'stripe';
import { db } from '../lib/db';
import { stripe } from '../lib/stripe';
import { logger } from '../lib/logger';
import { cancelSubscriptionNow, retrieveSubscription } from '../lib/billing';

// POST /api/webhooks/stripe — mounted directly in src/index.ts so it can use
// express.raw() ahead of the global express.json() middleware.
//
// Each event is applied exactly once. Stripe calls happen first (planEvent),
// then one transaction records the event id and applies the change. Any
// failure rolls both back and returns 500, so Stripe's retry runs it again.

type Apply = (client: PoolClient) => Promise<void>;
const noop: Apply = async () => {};

const LIVE_STATUSES = new Set(['active', 'trialing']);
const FREE_STATUSES = new Set(['canceled', 'unpaid', 'incomplete_expired']);

function idOf(ref: string | { id: string } | null | undefined): string | null {
  if (!ref) return null;
  return typeof ref === 'string' ? ref : ref.id;
}

// Works from the subscription's live state, not the event payload (events
// can arrive late or out of order). Lifetime accounts are never touched, and
// a live subscription on one is cancelled so it stops billing. A live
// subscription is adopted even if another id is stored, so a lost `deleted`
// event can't lock out a paying user; anything else only applies to the
// stored subscription.
async function planSubscription(subId: string, deleted: boolean): Promise<Apply> {
  const retrieved = await retrieveSubscription(subId);
  if (!retrieved) return noop; // Not known to this Stripe account.
  const customerId = idOf(retrieved.customer);
  if (!customerId) return noop;

  const { rows: current } = await db.query<{ subscription_interval: string | null }>(
    'SELECT subscription_interval FROM accounts WHERE stripe_customer_id = $1',
    [customerId],
  );
  if (current[0]?.subscription_interval === 'lifetime' && !deleted && LIVE_STATUSES.has(retrieved.status)) {
    await cancelSubscriptionNow(retrieved.id);
    logger.warn('Cancelled a subscription on a lifetime account', { subscriptionId: retrieved.id });
    return noop;
  }

  // Before downgrading, check for a second live subscription (two checkouts
  // at once); it is adopted instead, so the user keeps what they pay for.
  let sub = retrieved;
  let isDeleted = deleted;
  if (deleted || !LIVE_STATUSES.has(sub.status)) {
    const { data } = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 10 });
    const other = data.find((s) => s.id !== sub.id && LIVE_STATUSES.has(s.status));
    if (other) {
      logger.warn('Customer has more than one subscription', { subscriptionId: other.id });
      sub = other;
      isDeleted = false;
    }
  }

  return async (client) => {
    const { rows } = await client.query<{
      id: number;
      subscription_interval: string | null;
      stripe_subscription_id: string | null;
    }>(
      `SELECT id, subscription_interval, stripe_subscription_id FROM accounts
        WHERE stripe_customer_id = $1 FOR UPDATE`,
      [customerId],
    );
    const account = rows[0];
    if (!account || account.subscription_interval === 'lifetime') return;

    const live = !isDeleted && LIVE_STATUSES.has(sub.status);
    const isStored = account.stripe_subscription_id === null || account.stripe_subscription_id === sub.id;
    if (!live && !isStored) return;

    if (isDeleted) {
      await client.query(
        `UPDATE accounts
            SET subscription_tier = 'free', stripe_subscription_id = NULL,
                subscription_period_end = NULL, updated_at = NOW()
          WHERE id = $1`,
        [account.id],
      );
      return;
    }

    let tier: 'supporter' | 'free' | undefined;
    if (LIVE_STATUSES.has(sub.status)) tier = 'supporter';
    else if (FREE_STATUSES.has(sub.status)) tier = 'free';

    const recurringInterval = sub.items.data[0]?.price.recurring?.interval;
    let interval: 'monthly' | 'annual' | undefined;
    if (recurringInterval === 'month') interval = 'monthly';
    else if (recurringInterval === 'year') interval = 'annual';

    const periodEnd = sub.items.data[0]?.current_period_end ?? null;
    const cancelledAt = sub.cancel_at_period_end ? (sub.cancel_at ?? null) : null;

    const updates: string[] = ['stripe_subscription_id = $1', 'updated_at = NOW()'];
    const values: unknown[] = [sub.id];
    let idx = 2;
    if (tier) {
      updates.push(`subscription_tier = $${idx++}`);
      values.push(tier);
    }
    if (interval) {
      updates.push(`subscription_interval = $${idx++}`);
      values.push(interval);
    }
    updates.push(`subscription_period_end = to_timestamp($${idx++}::double precision)`);
    values.push(periodEnd);
    updates.push(`subscription_cancelled_at = to_timestamp($${idx++}::double precision)`);
    values.push(cancelledAt);
    values.push(account.id);
    await client.query(`UPDATE accounts SET ${updates.join(', ')} WHERE id = $${idx}`, values);
  };
}

// A lifetime purchase replaces any subscription, which is cancelled at Stripe
// first so the customer stops being billed. Its later `deleted` event is then
// ignored, because the account is lifetime by the time it arrives.
async function planLifetimeGrant(session: Stripe.Checkout.Session): Promise<Apply> {
  const customerId = idOf(session.customer);
  if (!customerId) return noop;
  const { rows } = await db.query<{ stripe_subscription_id: string | null }>(
    'SELECT stripe_subscription_id FROM accounts WHERE stripe_customer_id = $1',
    [customerId],
  );
  const subId = rows[0]?.stripe_subscription_id;
  if (subId) await cancelSubscriptionNow(subId);
  const paymentIntent = idOf(session.payment_intent);

  return async (client) => {
    await client.query(
      `UPDATE accounts
          SET subscription_tier = 'supporter', subscription_interval = 'lifetime',
              stripe_lifetime_payment_intent = COALESCE($2, stripe_lifetime_payment_intent),
              stripe_subscription_id = NULL, subscription_period_end = NULL,
              subscription_cancelled_at = NULL, updated_at = NOW()
        WHERE stripe_customer_id = $1`,
      [customerId, paymentIntent],
    );
  };
}

// Refunds and disputes only affect lifetime access; subscriptions follow
// Stripe's own lifecycle. The payment intent is kept so a won dispute can
// still find the account.
function revokeLifetime(paymentIntent: string | null): Apply {
  if (!paymentIntent) return noop;
  return async (client) => {
    const result = await client.query(
      `UPDATE accounts SET subscription_tier = 'free', subscription_interval = NULL, updated_at = NOW()
        WHERE stripe_lifetime_payment_intent = $1 AND subscription_interval = 'lifetime'`,
      [paymentIntent],
    );
    if (result.rowCount) logger.warn('Lifetime access revoked after a refund or dispute', { paymentIntent });
  };
}

function restoreLifetime(paymentIntent: string | null): Apply {
  if (!paymentIntent) return noop;
  return async (client) => {
    await client.query(
      `UPDATE accounts SET subscription_tier = 'supporter', subscription_interval = 'lifetime', updated_at = NOW()
        WHERE stripe_lifetime_payment_intent = $1 AND subscription_tier = 'free'`,
      [paymentIntent],
    );
  };
}

// Returns null for event types this handler doesn't act on; those aren't recorded.
async function planEvent(event: Stripe.Event): Promise<Apply | null> {
  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      return planSubscription(event.data.object.id, false);
    case 'customer.subscription.deleted':
      return planSubscription(event.data.object.id, true);
    case 'checkout.session.completed': {
      const session = event.data.object;
      // Delayed methods (bank debits) complete unpaid; the async events decide.
      if (session.mode !== 'payment' || session.payment_status !== 'paid') return noop;
      return planLifetimeGrant(session);
    }
    case 'checkout.session.async_payment_succeeded': {
      const session = event.data.object;
      return session.mode === 'payment' ? planLifetimeGrant(session) : noop;
    }
    case 'checkout.session.async_payment_failed':
      logger.warn('Stripe delayed payment failed', { sessionId: event.data.object.id });
      return noop;
    case 'charge.refunded': {
      const charge = event.data.object;
      // `refunded` is true only once the full amount is refunded.
      return charge.refunded ? revokeLifetime(idOf(charge.payment_intent)) : noop;
    }
    case 'charge.dispute.created':
      return revokeLifetime(idOf(event.data.object.payment_intent));
    case 'charge.dispute.closed': {
      const dispute = event.data.object;
      // A won dispute, or an inquiry (early warning) that closed without a
      // chargeback; inquiries fire `charge.dispute.created` too.
      const cleared = dispute.status === 'won' || dispute.status === 'warning_closed';
      return cleared ? restoreLifetime(idOf(dispute.payment_intent)) : noop;
    }
    default:
      return null;
  }
}

export async function handleStripeWebhook(req: Request, res: Response) {
  const signature = req.headers['stripe-signature'] as string;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET as string;

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(req.body as Buffer, signature, webhookSecret);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid signature';
    return res.status(400).json({ error: message });
  }

  try {
    const seen = await db.query('SELECT 1 FROM stripe_events WHERE event_id = $1', [event.id]);
    if (seen.rowCount) return res.json({ received: true });

    const apply = await planEvent(event);
    if (!apply) return res.json({ received: true });

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      // A concurrent delivery of the same event blocks here until the first
      // commits, then inserts nothing.
      const inserted = await client.query(
        'INSERT INTO stripe_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING',
        [event.id],
      );
      if (inserted.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.json({ received: true });
      }
      await apply(client);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    res.json({ received: true });
  } catch (err) {
    logger.error('POST /webhooks/stripe failed', err, { eventType: event.type });
    res.status(500).json({ error: 'Internal server error' });
  }
}

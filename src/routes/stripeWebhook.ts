import type { Request, Response } from 'express';
import type { PoolClient } from 'pg';
import Stripe from 'stripe';
import { db } from '../lib/db';
import { getStripe } from '../lib/stripe';
import { logger } from '../lib/logger';
import { cancelSubscriptionNow, retrieveSubscription } from '../lib/billing';
import { formatUsd, recordOwnerEvent, sendOwnerAlert } from '../lib/ownerAlerts';
import { checkoutAllowed, recordCountryCheck, type CheckKind, type CheckoutPlan } from '../lib/checkoutCountry';

// POST /api/webhooks/stripe — mounted directly in src/index.ts so it can use
// express.raw() ahead of the global express.json() middleware.
//
// Each event is applied exactly once. Stripe calls happen first (planEvent),
// then one transaction records the event id and applies the change. Any
// failure rolls both back and returns 500, so Stripe's retry runs it again.
// Owner alerts an apply step queues are sent only once it has committed.

type OwnerAlert = Parameters<typeof sendOwnerAlert>[0];
type Apply = (client: PoolClient, alerts: OwnerAlert[]) => Promise<void>;
const noop: Apply = async () => {};

const USERS_LINK = { label: 'Open users', path: '/admin/users' };
const REVOKED = 'Lifetime access was revoked automatically.';

// Left out of the alert, rather than guessed, when the event doesn't carry it.
function amountOf(cents: number | null | undefined, currency: string | null | undefined): string | null {
  return typeof cents === 'number' && currency ? formatUsd(cents, currency) : null;
}

// "Supporter, monthly, $5.00." with any missing part left out.
function sentence(parts: (string | null | undefined)[]): string {
  return `${parts.filter(Boolean).join(', ')}.`;
}

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
    const { data } = await getStripe().subscriptions.list({ customer: customerId, status: 'all', limit: 10 });
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
      subscription_tier: string;
      subscription_interval: string | null;
      stripe_subscription_id: string | null;
      subscription_cancelled_at: Date | null;
    }>(
      `SELECT id, subscription_tier, subscription_interval, stripe_subscription_id, subscription_cancelled_at
         FROM accounts WHERE stripe_customer_id = $1 FOR UPDATE`,
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
      // A cancel at period end was counted when it was set; this counts an immediate one.
      if (account.subscription_tier !== 'free' && account.subscription_cancelled_at === null) {
        await recordOwnerEvent('subscription_cancelled', client);
      }
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
    if (account.subscription_cancelled_at === null && cancelledAt !== null) {
      await recordOwnerEvent('subscription_cancelled', client);
    }
  };
}

// The customer.subscription.* events update the account; this only counts the
// new subscription and alerts the owner.
async function planSubscriptionStart(session: Stripe.Checkout.Session): Promise<Apply> {
  const customerId = idOf(session.customer);
  if (!customerId) return noop;
  const subId = idOf(session.subscription);
  let interval: string | undefined;
  if (subId) {
    try {
      const recurring = (await retrieveSubscription(subId))?.items.data[0]?.price.recurring?.interval;
      if (recurring === 'month') interval = 'monthly';
      // Display wording for the alert; the account stores 'annual'.
      else if (recurring === 'year') interval = 'yearly';
    } catch {
      // Only the alert's wording needs it, so a Stripe error doesn't fail the event.
    }
  }
  const amount = amountOf(session.amount_total, session.currency);

  return async (client, alerts) => {
    const { rowCount } = await client.query(
      `SELECT 1 FROM accounts
        WHERE stripe_customer_id = $1 AND subscription_interval IS DISTINCT FROM 'lifetime'`,
      [customerId],
    );
    if (!rowCount) return;
    await recordOwnerEvent('subscription_started', client);
    alerts.push({
      kind: 'subscription_started',
      subject: 'New Supporter subscription',
      lines: [sentence(['Supporter', interval, amount])],
      link: USERS_LINK,
    });
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
  const amount = amountOf(session.amount_total, session.currency);

  return async (client, alerts) => {
    const result = await client.query(
      `UPDATE accounts
          SET subscription_tier = 'supporter', subscription_interval = 'lifetime',
              stripe_lifetime_payment_intent = COALESCE($2, stripe_lifetime_payment_intent),
              stripe_subscription_id = NULL, subscription_period_end = NULL,
              subscription_cancelled_at = NULL, updated_at = NOW()
        WHERE stripe_customer_id = $1`,
      [customerId, paymentIntent],
    );
    if (!result.rowCount) return;
    await recordOwnerEvent('lifetime_purchased', client);
    alerts.push({
      kind: 'lifetime_purchased',
      subject: 'New lifetime purchase',
      lines: [sentence(['Lifetime', amount])],
      link: USERS_LINK,
    });
  };
}

function stripeErrorCode(err: unknown): string | undefined {
  return err instanceof Stripe.errors.StripeInvalidRequestError ? err.code : undefined;
}

// The issuing country of the card behind a payment intent's latest charge;
// null when there is no card or Stripe doesn't report its country.
async function cardCountryOf(paymentIntentId: string): Promise<string | null> {
  const intent = await getStripe().paymentIntents.retrieve(paymentIntentId, { expand: ['latest_charge'] });
  const charge = intent.latest_charge;
  if (!charge || typeof charge === 'string') return null;
  return charge.payment_method_details?.card?.country ?? null;
}

// The payment intent that paid an invoice. `invoice.payments` is only there
// when expanded and is itself a paged list, so the invoice payments API is
// used instead.
async function invoicePaymentIntent(invoiceId: string): Promise<string | null> {
  const { data } = await getStripe().invoicePayments.list({ invoice: invoiceId, limit: 10 });
  const intents = data.filter((p) => p.payment.type === 'payment_intent');
  const chosen = intents.find((p) => p.status === 'paid') ?? intents[0];
  return idOf(chosen?.payment.payment_intent);
}

// With its default payment method expanded, or null if Stripe no longer has it.
async function subscriptionWithCard(subId: string): Promise<Stripe.Subscription | null> {
  try {
    return await getStripe().subscriptions.retrieve(subId, { expand: ['default_payment_method'] });
  } catch (err) {
    if (stripeErrorCode(err) === 'resource_missing') return null;
    throw err;
  }
}

type CountryRefusal = { kind: CheckKind; country: string | null };

// The billing address is checked first, so it wins when both fail. A paid
// checkout must show an allowed card country (unknown counts as not allowed);
// a free one is checked on its card only if it has one.
async function countryRefusalOf(
  session: Stripe.Checkout.Session,
  paymentIntent: string | null,
  sub: Stripe.Subscription | null,
): Promise<CountryRefusal | null> {
  const address = session.customer_details?.address?.country ?? null;
  if (!checkoutAllowed(address)) return { kind: 'billing_address', country: address };

  if (session.payment_status !== 'no_payment_required') {
    const card = paymentIntent ? await cardCountryOf(paymentIntent) : null;
    if (!card) logger.warn('No card country on a paid checkout; refusing it', { sessionId: session.id });
    return checkoutAllowed(card) ? null : { kind: 'card_country', country: card };
  }

  const method = sub?.default_payment_method;
  if (!method || typeof method === 'string' || !method.card) return null;
  return checkoutAllowed(method.card.country) ? null : { kind: 'card_country', country: method.card.country };
}

const PLAN_LABELS: Record<CheckoutPlan, string> = { monthly: 'Monthly', annual: 'Annual', lifetime: 'Lifetime' };

async function checkoutPlanOf(session: Stripe.Checkout.Session, sub: Stripe.Subscription | null): Promise<CheckoutPlan> {
  const plan = session.metadata?.plan;
  if (plan === 'monthly' || plan === 'annual' || plan === 'lifetime') return plan;
  if (session.mode === 'payment') return 'lifetime';
  const subId = idOf(session.subscription);
  const interval = (sub ?? (subId ? await retrieveSubscription(subId) : null))?.items.data[0]?.price.recurring?.interval;
  if (interval === 'month') return 'monthly';
  if (interval === 'year') return 'annual';
  logger.warn('Could not tell the plan of a refused checkout; counted as monthly');
  return 'monthly';
}

// The idempotency key covers a retry after the transaction failed. A charge
// that is already refunded counts as done. Returns false when there was no
// payment to refund, so the owner is told to refund by hand.
async function refundInFull(sessionId: string, paymentIntent: string | null): Promise<boolean> {
  if (!paymentIntent) {
    logger.error('No payment found to refund for a refused checkout; refund it by hand', undefined, { sessionId });
    return false;
  }
  try {
    await getStripe().refunds.create(
      { payment_intent: paymentIntent },
      { idempotencyKey: `country-refund-${sessionId}` },
    );
  } catch (err) {
    if (stripeErrorCode(err) !== 'charge_already_refunded') throw err;
  }
  return true;
}

const REFUNDED_LINE = 'Refunded: paid plans are US-only at launch.';
const CANCELLED_LINE = 'Cancelled: paid plans are US-only at launch.';
const REFUND_NEEDED_LINE =
  'Refund needed: no payment was found to refund automatically. Refund it in the Stripe dashboard.';

// Paid plans are US-only at launch. Runs before anything is granted: a
// checkout from elsewhere is refunded (when paid) and its subscription
// cancelled, then recorded and alerted. Returns null when the checkout is allowed.
// Access to a subscription comes from the customer.subscription.* events; if
// `created` already landed, the account is set back to free here, and if it
// lands later it sees the cancelled subscription and leaves the account free.
async function planCountryRefusal(session: Stripe.Checkout.Session): Promise<Apply | null> {
  const paid = session.payment_status !== 'no_payment_required';
  const subId = session.mode === 'subscription' ? idOf(session.subscription) : null;

  let paymentIntent: string | null = null;
  if (session.mode === 'payment') {
    paymentIntent = idOf(session.payment_intent);
  } else if (paid) {
    const invoiceId = idOf(session.invoice);
    paymentIntent = invoiceId ? await invoicePaymentIntent(invoiceId) : null;
  }
  const sub = !paid && subId ? await subscriptionWithCard(subId) : null;

  const refusal = await countryRefusalOf(session, paymentIntent, sub);
  if (!refusal) return null;

  const plan = await checkoutPlanOf(session, sub);
  if (subId) await cancelSubscriptionNow(subId);
  let outcome = CANCELLED_LINE;
  if (paid) outcome = (await refundInFull(session.id, paymentIntent)) ? REFUNDED_LINE : REFUND_NEEDED_LINE;
  const amount = amountOf(session.amount_total, session.currency);

  return async (client, alerts) => {
    await recordCountryCheck({ country: refusal.country, plan, kind: refusal.kind }, client);
    if (subId) {
      await client.query(
        `UPDATE accounts
            SET subscription_tier = 'free', stripe_subscription_id = NULL, subscription_period_end = NULL,
                subscription_cancelled_at = NULL, updated_at = NOW()
          WHERE stripe_subscription_id = $1 AND subscription_interval IS DISTINCT FROM 'lifetime'`,
        [subId],
      );
    }
    alerts.push({
      kind: 'checkout_refused_country',
      subject: 'Checkout refused: outside the US',
      lines: [
        sentence([PLAN_LABELS[plan], refusal.country ?? 'country unknown', amount]),
        outcome,
      ],
      link: USERS_LINK,
    });
  };
}

// Refunds and disputes only affect lifetime access; subscriptions follow
// Stripe's own lifecycle. The payment intent is kept so a won dispute can
// still find the account. Returns whether a lifetime account was revoked.
async function revokeLifetime(client: PoolClient, paymentIntent: string): Promise<boolean> {
  const result = await client.query(
    `UPDATE accounts SET subscription_tier = 'free', subscription_interval = NULL, updated_at = NOW()
      WHERE stripe_lifetime_payment_intent = $1 AND subscription_interval = 'lifetime'`,
    [paymentIntent],
  );
  if (result.rowCount) logger.warn('Lifetime access revoked after a refund or dispute', { paymentIntent });
  return Boolean(result.rowCount);
}

// Only a refund that revoked lifetime access is counted.
function planRefund(charge: Stripe.Charge): Apply {
  const paymentIntent = idOf(charge.payment_intent);
  if (!paymentIntent) return noop;
  const amount = amountOf(charge.amount_refunded, charge.currency);
  return async (client, alerts) => {
    if (!(await revokeLifetime(client, paymentIntent))) return;
    await recordOwnerEvent('refund', client);
    alerts.push({
      kind: 'refund',
      subject: 'A lifetime payment was refunded',
      lines: [`${amount ?? 'A payment was'} refunded. ${REVOKED}`],
      link: USERS_LINK,
    });
  };
}

// Every dispute is counted, lifetime or not, since each one needs an answer in Stripe.
function planDispute(dispute: Stripe.Dispute): Apply {
  const paymentIntent = idOf(dispute.payment_intent);
  const amount = amountOf(dispute.amount, dispute.currency);
  return async (client, alerts) => {
    const revoked = paymentIntent ? await revokeLifetime(client, paymentIntent) : false;
    await recordOwnerEvent('dispute', client);
    const disputed = `${amount ?? 'A payment was'} disputed.`;
    alerts.push({
      kind: 'dispute',
      subject: 'A payment was disputed',
      lines: [
        revoked ? `${disputed} ${REVOKED}` : disputed,
        'Stripe sets a deadline to respond. Answer it in the Stripe dashboard.',
      ],
      link: USERS_LINK,
    });
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
      if (session.mode === 'subscription') {
        // 'no_payment_required' (full discounts, trials) counts too.
        if (session.payment_status === 'unpaid') return noop;
        return (await planCountryRefusal(session)) ?? planSubscriptionStart(session);
      }
      if (session.mode !== 'payment' || session.payment_status !== 'paid') return noop;
      // A refused lifetime purchase must not reach planLifetimeGrant, which
      // cancels the account's current subscription.
      return (await planCountryRefusal(session)) ?? planLifetimeGrant(session);
    }
    case 'checkout.session.async_payment_succeeded': {
      const session = event.data.object;
      if (session.mode !== 'payment' && session.mode !== 'subscription') return noop;
      const refusal = await planCountryRefusal(session);
      if (refusal) return refusal;
      return session.mode === 'payment' ? planLifetimeGrant(session) : planSubscriptionStart(session);
    }
    case 'checkout.session.async_payment_failed':
      logger.warn('Stripe delayed payment failed', { sessionId: event.data.object.id });
      return noop;
    case 'charge.refunded': {
      const charge = event.data.object;
      // `refunded` is true only once the full amount is refunded.
      return charge.refunded ? planRefund(charge) : noop;
    }
    case 'charge.dispute.created':
      return planDispute(event.data.object);
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
    event = getStripe().webhooks.constructEvent(req.body as Buffer, signature, webhookSecret);
  } catch (err) {
    // The SDK's message stays in our log; the caller only learns it failed.
    logger.warn('Stripe webhook signature check failed', {
      errMsg: err instanceof Error ? err.message : String(err),
    });
    return res.status(400).json({ error: 'Invalid signature' });
  }

  try {
    const seen = await db.query('SELECT 1 FROM stripe_events WHERE event_id = $1', [event.id]);
    if (seen.rowCount) return res.json({ received: true });

    const apply = await planEvent(event);
    if (!apply) return res.json({ received: true });

    const alerts: OwnerAlert[] = [];
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
      await apply(client, alerts);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    for (const alert of alerts) void sendOwnerAlert(alert);
    res.json({ received: true });
  } catch (err) {
    logger.error('POST /webhooks/stripe failed', err, { eventType: event.type });
    res.status(500).json({ error: 'Internal server error' });
  }
}

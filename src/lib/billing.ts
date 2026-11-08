import Stripe from 'stripe';
import { getStripeForCleanup } from './stripe';
import { logger } from './logger';

// Stripe calls tied to the account-deletion lifecycle. Objects that are
// already gone (canceled subscription, deleted customer) are treated as done;
// any other error propagates so the caller can refuse or retry.

// Subscriptions that are finished (teardown has nothing to cancel).
const ENDED = new Set(['canceled', 'incomplete_expired']);
// Nothing to stop or resume (stop/resume skip these; teardown still cancels
// 'incomplete' so no half-open checkout survives the purge).
const NO_RENEWAL = new Set([...ENDED, 'incomplete']);

const PAUSE_MARKER = 'vernal_deletion_pause';

function isMissing(err: unknown): boolean {
  return err instanceof Stripe.errors.StripeInvalidRequestError && err.code === 'resource_missing';
}

// The client for these calls, or null (with a warning) when no key is set:
// deletion and purge then carry on, and the operator cancels in Stripe by hand.
function cleanupClient(action: string, accountId: number): Stripe | null {
  const stripe = getStripeForCleanup();
  if (!stripe) logger.warn('Stripe not configured: billing step skipped', { action, accountId });
  return stripe;
}

// Webhook-only helpers run with billing on, where a key is required at startup.
function requireClient(): Stripe {
  const stripe = getStripeForCleanup();
  if (!stripe) throw new Error('STRIPE_SECRET_KEY environment variable is required');
  return stripe;
}

// Returns the subscription, or null if Stripe no longer has it.
async function retrieveWith(stripe: Stripe, subId: string): Promise<Stripe.Subscription | null> {
  try {
    return await stripe.subscriptions.retrieve(subId);
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

export async function retrieveSubscription(subId: string): Promise<Stripe.Subscription | null> {
  return retrieveWith(requireClient(), subId);
}

// Deletion requested: let the paid period run out, never renew. A subscription
// the user already set to cancel is left alone and unmarked, so cancelling the
// deletion never re-enables renewal the user chose themselves.
export async function stopRenewal(subId: string, accountId: number): Promise<void> {
  const stripe = cleanupClient('stopRenewal', accountId);
  if (!stripe) return;
  const sub = await retrieveWith(stripe, subId);
  if (!sub || NO_RENEWAL.has(sub.status)) return;
  if (sub.cancel_at_period_end) return;
  await stripe.subscriptions.update(subId, {
    cancel_at_period_end: true,
    metadata: { [PAUSE_MARKER]: '1' },
  });
}

// Deletion cancelled: turn renewal back on, but only if we turned it off.
// Known limitation (accepted): a portal cancellation made during the deletion
// window, while our marker is set, is indistinguishable and will be undone.
export async function resumeRenewal(subId: string, accountId: number): Promise<void> {
  const stripe = cleanupClient('resumeRenewal', accountId);
  if (!stripe) return;
  const sub = await retrieveWith(stripe, subId);
  if (!sub || NO_RENEWAL.has(sub.status)) return;
  if (sub.metadata?.[PAUSE_MARKER] !== '1') return;
  // An empty string unsets a Stripe metadata key.
  await stripe.subscriptions.update(subId, {
    cancel_at_period_end: false,
    metadata: { [PAUSE_MARKER]: '' },
  });
}

// Ends a subscription immediately (a lifetime purchase replaces it). One that
// has already ended, or that Stripe no longer has, counts as done.
async function cancelWith(stripe: Stripe, subId: string): Promise<void> {
  const sub = await retrieveWith(stripe, subId);
  if (!sub || ENDED.has(sub.status)) return;
  try {
    await stripe.subscriptions.cancel(subId);
  } catch (err) {
    if (!isMissing(err)) throw err;
  }
}

export async function cancelSubscriptionNow(subId: string): Promise<void> {
  return cancelWith(requireClient(), subId);
}

const DISPLACEMENT_MARKER = 'vernal_displacement';

function idOf(ref: string | { id: string } | null | undefined): string | null {
  if (!ref) return null;
  return typeof ref === 'string' ? ref : ref.id;
}

// Stripe refused the request itself (a 4xx other than rate limiting): a retry
// would fail the same way.
function isRefused(err: unknown): boolean {
  if (!(err instanceof Stripe.errors.StripeError)) return false;
  if (err instanceof Stripe.errors.StripeRateLimitError) return false;
  if (err instanceof Stripe.errors.StripeInvalidRequestError || err instanceof Stripe.errors.StripeCardError) return true;
  const status = err.statusCode;
  return status !== undefined && status >= 400 && status < 500 && status !== 429;
}

async function retrieveInvoice(
  stripe: Stripe,
  ref: string | { id?: string } | null | undefined,
): Promise<Stripe.Invoice | null> {
  const id = typeof ref === 'string' ? ref : ref?.id;
  return id ? stripe.invoices.retrieve(id) : null;
}

// Unpaid invoices left open after cancelling would still be collected, so
// every open invoice of the subscription is voided, not just the latest.
async function voidOpenInvoices(stripe: Stripe, subId: string, accountId: number): Promise<void> {
  const open = await stripe.invoices.list({ subscription: subId, status: 'open', limit: 100 });
  for (const invoice of open.data) {
    if (!invoice.id || invoice.status !== 'open') continue;
    try {
      await stripe.invoices.voidInvoice(invoice.id);
    } catch (err) {
      if (!isRefused(err)) throw err;
      logger.error('Could not void the open invoice of a displaced subscription; void it by hand', err, {
        accountId,
        subId,
        invoiceId: invoice.id,
      });
    }
  }
}

// The live subscriptions on a customer, so displacement ends every one, not
// just the one the account row points at.
export async function liveSubscriptionIds(customerId: string, accountId: number): Promise<string[]> {
  const stripe = cleanupClient('liveSubscriptionIds', accountId);
  if (!stripe) return [];
  try {
    const subs = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 });
    return subs.data.filter((s) => !ENDED.has(s.status)).map((s) => s.id);
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }
}

// Displacement (the address's owner took it back from an unverified account):
// end the subscription now. When the current period is paid, the unused time
// is refunded to the card: Stripe puts it on the customer's credit balance
// (prorate + invoice_now); we refund that amount against the last payment and
// set the balance back, as Stripe's cancellation guide describes. When it
// isn't paid (past due, unpaid, open invoice) nothing is refunded: the
// subscription ends without proration. Either way every open invoice is
// voided. Only a credit this call created is refunded: a subscription that had
// already ended (by any route, including an earlier attempt of ours) gets its
// open invoices voided and, if it shows a credit, is logged for manual review.
export async function cancelAndRefundUnused(subId: string, accountId: number): Promise<void> {
  const stripe = cleanupClient('cancelAndRefundUnused', accountId);
  if (!stripe) return;
  let sub = await retrieveWith(stripe, subId);
  if (!sub) return;
  const latest = await retrieveInvoice(stripe, sub.latest_invoice);
  if (ENDED.has(sub.status)) {
    await voidOpenInvoices(stripe, subId, accountId);
    if (latest && latest.total < 0) {
      logger.error('Displaced subscription had already ended with a credit; review it by hand', undefined, {
        accountId,
        subId,
        credit: -latest.total,
      });
    }
    return;
  }
  const paidUp = latest?.status === 'paid' && (sub.status === 'active' || sub.status === 'trialing');
  try {
    sub = await stripe.subscriptions.cancel(
      subId,
      paidUp ? { prorate: true, invoice_now: true } : { prorate: false, invoice_now: false },
    );
  } catch (err) {
    if (isMissing(err)) return;
    throw err;
  }
  await voidOpenInvoices(stripe, subId, accountId);
  if (!paidUp) return;

  // The final invoice carries the credit as a negative total.
  const final =
    latest && idOf(sub.latest_invoice) === latest.id ? latest : await retrieveInvoice(stripe, sub.latest_invoice);
  if (!final?.id) return;
  const finalId = final.id;
  const credit = -final.total;
  if (credit <= 0) return;

  const paid = await stripe.invoices.list({ subscription: subId, status: 'paid', limit: 10 });
  const source = paid.data.find((inv) => inv.id !== finalId && inv.amount_paid > 0);
  const payment = source
    ? (await stripe.invoicePayments.list({ invoice: source.id, status: 'paid', limit: 1 })).data[0]?.payment
    : undefined;
  const paymentIntent = idOf(payment?.payment_intent);
  const charge = idOf(payment?.charge);
  if (!source || (!paymentIntent && !charge)) {
    logger.error('No payment found to refund unused time; refund it by hand', undefined, { accountId, subId, credit });
    return;
  }
  const target = paymentIntent ? { payment_intent: paymentIntent } : { charge: charge! };

  const existing = await stripe.refunds.list({ ...target, limit: 100 });
  const done = existing.data.find((r) => r.metadata?.[DISPLACEMENT_MARKER] === subId);
  let amount: number;
  if (done) {
    // Refunded on an earlier attempt; the balance may still need zeroing.
    amount = done.amount;
  } else {
    amount = Math.min(credit, source.amount_paid);
    if (amount < credit) {
      logger.error('Unused time exceeds the last payment; refund the rest by hand', undefined, {
        accountId,
        subId,
        credit,
        refunded: amount,
      });
    }
    try {
      await stripe.refunds.create(
        { ...target, amount, reason: 'requested_by_customer', metadata: { [DISPLACEMENT_MARKER]: subId } },
        { idempotencyKey: `displacement-refund-${subId}` },
      );
    } catch (err) {
      // The subscription is already cancelled, so a refusal is left for a
      // manual refund instead of failing the displacement. The credit stays
      // on the balance until then.
      if (!isRefused(err)) throw err;
      logger.error('Stripe refused the unused-time refund; refund it by hand', err, { accountId, subId, amount });
      return;
    }
  }

  // The refund replaces the credit, so the balance goes back to zero, once.
  const customerId = idOf(sub.customer);
  if (customerId) {
    const balance = await stripe.customers.listBalanceTransactions(customerId, { limit: 100 });
    if (balance.data.some((t) => t.metadata?.[DISPLACEMENT_MARKER] === subId)) return;
    await stripe.customers.createBalanceTransaction(
      customerId,
      {
        amount,
        currency: final.currency,
        description: 'Unused time refunded to the card',
        metadata: { [DISPLACEMENT_MARKER]: subId },
      },
      { idempotencyKey: `displacement-balance-${subId}` },
    );
  }
}

// Displacement, before any subscription is cancelled: an open Checkout
// session could still start a new subscription or a lifetime purchase on the
// customer afterwards. Failures are logged, not fatal: the session expires on
// its own within a day.
export async function expireOpenCheckoutSessions(customerId: string, accountId: number): Promise<void> {
  const stripe = cleanupClient('expireOpenCheckoutSessions', accountId);
  if (!stripe) return;
  let sessions: Stripe.Checkout.Session[];
  try {
    sessions = (await stripe.checkout.sessions.list({ customer: customerId, status: 'open', limit: 100 })).data;
  } catch (err) {
    if (isMissing(err)) return;
    logger.error("Could not list a displaced account's open Checkout sessions; expire them by hand", err, {
      accountId,
      customerId,
    });
    return;
  }
  for (const session of sessions) {
    try {
      await stripe.checkout.sessions.expire(session.id);
    } catch (err) {
      logger.error("Could not expire a displaced account's open Checkout session; expire it by hand", err, {
        accountId,
        customerId,
        sessionId: session.id,
      });
    }
  }
}

// After a displacement commits: the customer stays until the purge, but
// without the owner's contact details (email, name, phone, address,
// shipping). Payment methods are left alone: they hold no address of ours to
// free, and deleting the customer at purge removes them. Not fatal; logged for
// a manual fix.
export async function forgetCustomerContact(customerId: string, accountId: number): Promise<void> {
  const stripe = cleanupClient('forgetCustomerContact', accountId);
  if (!stripe) return;
  try {
    // An empty string unsets a Stripe field.
    await stripe.customers.update(customerId, { email: '', name: '', phone: '', address: '', shipping: '' });
  } catch (err) {
    if (isMissing(err)) return;
    logger.error("Could not clear a displaced account's Stripe customer contact; clear it by hand", err, {
      accountId,
      customerId,
    });
  }
}

// Account purge: end any remaining subscription now and delete the customer
// (and with it the stored email and payment methods).
export async function teardownCustomer({
  subId,
  customerId,
  accountId,
}: {
  subId: string | null;
  customerId: string | null;
  accountId: number;
}): Promise<void> {
  if (!subId && !customerId) return;
  const stripe = cleanupClient('teardownCustomer', accountId);
  if (!stripe) return;
  if (subId) await cancelWith(stripe, subId);
  if (customerId) {
    try {
      await stripe.customers.del(customerId);
    } catch (err) {
      if (!isMissing(err)) throw err;
    }
  }
}

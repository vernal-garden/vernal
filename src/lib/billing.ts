import Stripe from 'stripe';
import { stripe } from './stripe';

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

// Returns the subscription, or null if Stripe no longer has it.
async function retrieveSubscription(subId: string): Promise<Stripe.Subscription | null> {
  try {
    return await stripe.subscriptions.retrieve(subId);
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

// Deletion requested: let the paid period run out, never renew. A subscription
// the user already set to cancel is left alone and unmarked, so cancelling the
// deletion never re-enables renewal the user chose themselves.
export async function stopRenewal(subId: string): Promise<void> {
  const sub = await retrieveSubscription(subId);
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
export async function resumeRenewal(subId: string): Promise<void> {
  const sub = await retrieveSubscription(subId);
  if (!sub || NO_RENEWAL.has(sub.status)) return;
  if (sub.metadata?.[PAUSE_MARKER] !== '1') return;
  // An empty string unsets a Stripe metadata key.
  await stripe.subscriptions.update(subId, {
    cancel_at_period_end: false,
    metadata: { [PAUSE_MARKER]: '' },
  });
}

// Account purge: end any remaining subscription now and delete the customer
// (and with it the stored email and payment methods).
export async function teardownCustomer({
  subId,
  customerId,
}: {
  subId: string | null;
  customerId: string | null;
}): Promise<void> {
  if (subId) {
    const sub = await retrieveSubscription(subId);
    if (sub && !ENDED.has(sub.status)) await stripe.subscriptions.cancel(subId);
  }
  if (customerId) {
    try {
      await stripe.customers.del(customerId);
    } catch (err) {
      if (!isMissing(err)) throw err;
    }
  }
}

import type { Pool, PoolClient } from 'pg';
import { cancelAndRefundUnused, expireOpenCheckoutSessions, forgetCustomerContact, liveSubscriptionIds } from './billing';
import { db } from './db';
import { logger } from './logger';
import { revokeAccountSessions } from './sessions';

// Displacement: when someone proves the inbox of an UNVERIFIED account (Google
// sign-in, a password reset, or the verification email) and says they did
// not create it, that account is deleted rather than handed over. The earlier
// account keeps its content (purged 30 days later like any deletion) and its
// Stripe customer (torn down at purge), and nothing links it to any account
// the owner gets afterwards.

// What settleDisplacedBilling found, for finishDisplacement after the commit.
export interface SettledBilling {
  accountId: number;
  customerId: string | null;
  lifetimePaymentIntent: string | null;
}

// Stripe first, before any DB change (as DELETE /me does): open Checkout
// sessions are expired, then every live subscription on the account's
// customer is cancelled now, with the unused time refunded when the period
// was paid. Throws if a cancellation or refund fails, so the
// caller refuses and changes nothing. A lifetime purchase is not refunded
// automatically; finishDisplacement flags it once the displacement commits.
// If the caller then doesn't displace, it must call billingSettledNotDisplaced.
export async function settleDisplacedBilling(runner: Pool | PoolClient, accountId: number): Promise<SettledBilling> {
  const { rows } = await runner.query<{
    stripe_customer_id: string | null;
    stripe_subscription_id: string | null;
    stripe_lifetime_payment_intent: string | null;
  }>(
    'SELECT stripe_customer_id, stripe_subscription_id, stripe_lifetime_payment_intent FROM accounts WHERE id = $1',
    [accountId],
  );
  const row = rows[0];
  const settled: SettledBilling = {
    accountId,
    customerId: row?.stripe_customer_id ?? null,
    lifetimePaymentIntent: row?.stripe_lifetime_payment_intent ?? null,
  };
  if (!row) return settled;
  const subIds = new Set<string>();
  if (row.stripe_subscription_id) subIds.add(row.stripe_subscription_id);
  if (row.stripe_customer_id) {
    // First, so no checkout completes a new subscription after the cancels below.
    await expireOpenCheckoutSessions(row.stripe_customer_id, accountId);
    for (const id of await liveSubscriptionIds(row.stripe_customer_id, accountId)) subIds.add(id);
  }
  for (const id of subIds) await cancelAndRefundUnused(id, accountId);
  return settled;
}

// Billing was settled but this request's transaction then didn't displace the
// account (token expired, account changed or verified, sign-up refused, DB
// error). An operator reconciles it by hand, unless a racing request
// displaced the account after all. Never throws (it runs in finally blocks).
export async function billingSettledNotDisplaced(accountId: number): Promise<void> {
  try {
    const { rows } = await db.query<{ displaced: boolean }>(
      'SELECT displaced_at IS NOT NULL AS displaced FROM accounts WHERE id = $1',
      [accountId],
    );
    if (rows[0]?.displaced) {
      logger.warn('Displacement billing settled; account already displaced by another request', { accountId });
      return;
    }
  } catch {
    // Can't tell: report it for review.
  }
  logger.error('Displacement billing settled but account not displaced', undefined, { accountId });
}

// Inside the caller's transaction, with the row already locked. The address is
// swapped for a non-routable placeholder (accounts.email is UNIQUE NOT NULL) so
// the owner can take it; the original is kept nowhere.
export async function displaceAccount(client: PoolClient, accountId: number): Promise<void> {
  await client.query(
    `UPDATE accounts
        SET email = 'displaced-' || id || '@displaced.invalid', password_hash = NULL, pending_email = NULL,
            deletion_scheduled_at = COALESCE(deletion_scheduled_at, NOW()), displaced_at = NOW(), updated_at = NOW()
      WHERE id = $1`,
    [accountId],
  );
  await client.query('DELETE FROM password_reset_tokens WHERE account_id = $1', [accountId]);
  await client.query('DELETE FROM email_change_tokens WHERE account_id = $1', [accountId]);
  await client.query('DELETE FROM email_verification_tokens WHERE account_id = $1', [accountId]);
  // Revert tokens and held Google sign-ins hold addresses too.
  await client.query('DELETE FROM email_revert_tokens WHERE account_id = $1', [accountId]);
  await client.query('DELETE FROM pending_takeovers WHERE account_id = $1', [accountId]);
  await revokeAccountSessions(client, accountId);
}

// After the displacement commits. Only the earlier account's id is logged:
// nothing ties it to any account the owner gets. The Stripe customer loses
// the owner's address and name (not fatal).
export async function finishDisplacement(settled: SettledBilling, context: Record<string, unknown>): Promise<void> {
  const { accountId } = settled;
  logger.warn('Account displaced by the address owner', { accountId, ...context });
  if (settled.lifetimePaymentIntent) {
    logger.error(`Lifetime purchase on displaced account ${accountId} needs a manual refund review`, undefined, {
      accountId,
      paymentIntent: settled.lifetimePaymentIntent,
    });
  }
  if (settled.customerId) await forgetCustomerContact(settled.customerId, accountId);
}

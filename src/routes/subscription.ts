import crypto from 'crypto';
import { Router } from 'express';
import Stripe from 'stripe';
import { db } from '../lib/db';
import { stripe } from '../lib/stripe';
import { requireAuth } from '../middleware/auth';
import { checkoutLimiter } from '../middleware/rateLimiters';

type Interval = 'monthly' | 'annual' | 'lifetime';

const PRICE_IDS: Record<Interval, string> = {
  monthly: process.env.STRIPE_PRICE_MONTHLY!,
  annual: process.env.STRIPE_PRICE_ANNUAL!,
  lifetime: process.env.STRIPE_PRICE_LIFETIME!,
};

const LIVE_STATUSES = new Set(['active', 'trialing']);

// Account ids repeat across databases (dev, CI, local) that share one Stripe
// test key, so the idempotency key carries a short id of the database.
const DB_SCOPE = crypto
  .createHash('sha256')
  .update((process.env.NODE_ENV === 'test' ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL) ?? '')
  .digest('hex')
  .slice(0, 12);

const router = Router();
router.use(requireAuth);

interface SubscriptionRow {
  subscription_tier: 'free' | 'supporter';
  subscription_interval: string | null;
  subscription_period_end: string | null;
  subscription_cancelled_at: string | null;
  stripe_customer_id: string | null;
}

// GET /api/subscription
router.get('/', async (req, res) => {
  try {
    const accountId = req.session!.account!.id;
    const { rows } = await db.query<SubscriptionRow>(
      `SELECT subscription_tier, subscription_interval, subscription_period_end,
              subscription_cancelled_at, stripe_customer_id
       FROM accounts WHERE id = $1`,
      [accountId],
    );
    if (rows.length === 0) {
      return res.status(401).json({ error: 'Account not found' });
    }
    const row = rows[0];
    res.json({
      tier: row.subscription_tier,
      isSupporter: row.subscription_tier === 'supporter',
      interval: row.subscription_interval,
      periodEnd: row.subscription_period_end,
      cancelledAt: row.subscription_cancelled_at,
      hasCustomer: !!row.stripe_customer_id,
    });
  } catch (err) {
    console.error('GET /subscription error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/subscription/checkout
router.post('/checkout', checkoutLimiter, async (req, res) => {
  const { interval } = req.body as { interval?: unknown };
  if (interval !== 'monthly' && interval !== 'annual' && interval !== 'lifetime') {
    return res.status(400).json({ error: 'interval must be monthly, annual, or lifetime' });
  }

  const mode: Stripe.Checkout.SessionCreateParams.Mode =
    interval === 'lifetime' ? 'payment' : 'subscription';
  const accountId = req.session!.account!.id;

  try {
    const { rows } = await db.query<{
      email: string;
      display_name: string | null;
      stripe_customer_id: string | null;
      deletion_scheduled_at: string | null;
      subscription_tier: 'free' | 'supporter';
      subscription_interval: string | null;
    }>(
      `SELECT email, display_name, stripe_customer_id, deletion_scheduled_at,
              subscription_tier, subscription_interval
       FROM accounts WHERE id = $1`,
      [accountId],
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: 'Account not found' });
    }
    if (rows[0].deletion_scheduled_at) {
      return res
        .status(409)
        .json({ error: 'Your account is scheduled for deletion. Cancel the deletion before subscribing.' });
    }

    // A supporter can only move up to lifetime; anything else is a duplicate
    // purchase (a second subscription, or a second lifetime payment).
    const current = rows[0];
    if (
      current.subscription_tier === 'supporter' &&
      (current.subscription_interval === 'lifetime' || interval !== 'lifetime')
    ) {
      return res.status(409).json({ error: "You're already a supporter.", code: 'already_supporter' });
    }

    let customerId = rows[0].stripe_customer_id;
    if (customerId && interval !== 'lifetime') {
      // The tier may lag Stripe (a second checkout before the first one's
      // webhook lands), so ask Stripe for a live subscription too.
      const { data } = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 10 });
      if (data.some((s) => LIVE_STATUSES.has(s.status))) {
        return res.status(409).json({ error: "You're already a supporter.", code: 'already_supporter' });
      }
    }
    if (!customerId) {
      // The idempotency key makes a double-click or retry return the same
      // Stripe customer instead of creating a second one.
      const customer = await stripe.customers.create(
        {
          email: rows[0].email,
          name: rows[0].display_name ?? undefined,
          metadata: { accountId: String(accountId) },
        },
        { idempotencyKey: `customer-create-${DB_SCOPE}-${accountId}` },
      );
      await db.query(
        'UPDATE accounts SET stripe_customer_id = $1, updated_at = NOW() WHERE id = $2 AND stripe_customer_id IS NULL',
        [customer.id, accountId],
      );
      // A concurrent request may have stored its customer first; use that one.
      const { rows: stored } = await db.query<{ stripe_customer_id: string | null }>(
        'SELECT stripe_customer_id FROM accounts WHERE id = $1',
        [accountId],
      );
      customerId = stored[0]?.stripe_customer_id ?? customer.id;
    }

    const session = await stripe.checkout.sessions.create({
      mode,
      customer: customerId,
      line_items: [{ price: PRICE_IDS[interval], quantity: 1 }],
      allow_promotion_codes: true,
      success_url: process.env.STRIPE_SUCCESS_URL!,
      cancel_url: process.env.STRIPE_CANCEL_URL!,
      metadata: { accountId: String(accountId) },
      ...(mode === 'subscription'
        ? { subscription_data: { metadata: { accountId: String(accountId) } } }
        : {}),
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('POST /subscription/checkout error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/subscription/portal
router.post('/portal', async (req, res) => {
  const accountId = req.session!.account!.id;

  try {
    const { rows } = await db.query<{ stripe_customer_id: string | null }>(
      'SELECT stripe_customer_id FROM accounts WHERE id = $1',
      [accountId],
    );

    const customerId = rows[0]?.stripe_customer_id;
    if (!customerId) {
      return res.status(400).json({ error: 'No billing account found. Please subscribe first.' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: process.env.STRIPE_CANCEL_URL!,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('POST /subscription/portal error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;

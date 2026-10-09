import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { db } from '../lib/db';
import { stripe } from '../lib/stripe';
import { requireAuth } from '../middleware/auth';

type Interval = 'monthly' | 'annual' | 'lifetime';

const PRICE_IDS: Record<Interval, string> = {
  monthly: process.env.STRIPE_PRICE_MONTHLY!,
  annual: process.env.STRIPE_PRICE_ANNUAL!,
  lifetime: process.env.STRIPE_PRICE_LIFETIME!,
};

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
router.post('/checkout', async (req, res) => {
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
    }>('SELECT email, display_name, stripe_customer_id FROM accounts WHERE id = $1', [accountId]);

    if (rows.length === 0) {
      return res.status(401).json({ error: 'Account not found' });
    }

    let customerId = rows[0].stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: rows[0].email,
        name: rows[0].display_name ?? undefined,
        metadata: { accountId: String(accountId) },
      });
      customerId = customer.id;
      await db.query(
        'UPDATE accounts SET stripe_customer_id = $1, updated_at = NOW() WHERE id = $2',
        [customerId, accountId],
      );
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

// POST /api/webhooks/stripe — mounted directly in src/index.ts (not on this router)
// so it can use express.raw() ahead of the global express.json() middleware.
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
    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data.object;

        let tier: 'supporter' | 'free' | undefined;
        if (['active', 'trialing'].includes(sub.status)) {
          tier = 'supporter';
        } else if (['canceled', 'unpaid', 'incomplete_expired'].includes(sub.status)) {
          tier = 'free';
        }

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

        values.push(sub.customer as string);
        await db.query(
          `UPDATE accounts SET ${updates.join(', ')} WHERE stripe_customer_id = $${idx}`,
          values,
        );
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        await db.query(
          `UPDATE accounts
           SET subscription_tier = 'free',
               stripe_subscription_id = NULL,
               subscription_period_end = NULL,
               updated_at = NOW()
           WHERE stripe_customer_id = $1`,
          [sub.customer as string],
        );
        break;
      }

      case 'checkout.session.completed': {
        const session = event.data.object;
        if (session.mode === 'payment') {
          await db.query(
            `UPDATE accounts
             SET subscription_tier = 'supporter',
                 subscription_interval = 'lifetime',
                 subscription_period_end = NULL,
                 stripe_subscription_id = NULL,
                 updated_at = NOW()
             WHERE stripe_customer_id = $1`,
            [session.customer as string],
          );
        }
        break;
      }

      default:
        break;
    }

    res.json({ received: true });
  } catch (err) {
    console.error('POST /webhooks/stripe error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export default router;

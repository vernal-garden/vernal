import dotenv from 'dotenv';
import { Pool } from 'pg';
import Stripe from 'stripe';

dotenv.config();

// One-off: records the payment intent behind each existing lifetime purchase,
// so refunds and disputes can find the account. Dry run by default; pass
// --apply to write. Safe to re-run: it only fills empty values.

const apply = process.argv.includes('--apply');

if (!process.env.DATABASE_URL || !process.env.STRIPE_SECRET_KEY) {
  console.error('DATABASE_URL and STRIPE_SECRET_KEY must be set');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// The newest paid one-off checkout for the customer. Stripe lists newest first.
async function latestLifetimePaymentIntent(customerId: string): Promise<string | null> {
  for await (const session of stripe.checkout.sessions.list({ customer: customerId, status: 'complete', limit: 100 })) {
    if (session.mode === 'payment' && session.payment_status === 'paid' && session.payment_intent) {
      return typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent.id;
    }
  }
  return null;
}

async function main(): Promise<void> {
  const { rows } = await pool.query<{ id: number; stripe_customer_id: string }>(
    `SELECT id, stripe_customer_id FROM accounts
      WHERE subscription_interval = 'lifetime'
        AND stripe_customer_id IS NOT NULL
        AND stripe_lifetime_payment_intent IS NULL
      ORDER BY id`,
  );
  console.log(`${rows.length} lifetime account(s) without a payment intent${apply ? '' : ' (dry run)'}`);

  let matched = 0;
  for (const row of rows) {
    const paymentIntent = await latestLifetimePaymentIntent(row.stripe_customer_id);
    if (!paymentIntent) {
      console.log(`account ${row.id} → no match`);
      continue;
    }
    matched += 1;
    console.log(`account ${row.id} → ${paymentIntent}`);
    if (apply) {
      await pool.query(
        `UPDATE accounts SET stripe_lifetime_payment_intent = $1, updated_at = NOW()
          WHERE id = $2 AND stripe_lifetime_payment_intent IS NULL`,
        [paymentIntent, row.id],
      );
    }
  }
  console.log(`${matched} matched${apply ? ' and written' : '; re-run with --apply to write'}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

import Stripe from 'stripe';
import { getServerConfig } from './serverConfig';

let instance: Stripe | null = null;

function client(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) return null;
  instance ??= new Stripe(key, { timeout: 15_000 });
  return instance;
}

// Built on first use so a server running with BILLING=off never needs a key.
export function getStripe(): Stripe {
  if (getServerConfig().billing === 'off') {
    throw new Error('Stripe is not available: BILLING=off');
  }
  const stripe = client();
  if (!stripe) throw new Error('STRIPE_SECRET_KEY environment variable is required');
  return stripe;
}

// For account deletion and purge only: works whenever a key is set, even with
// BILLING=off, so a server that moved off Stripe still stops charging deleted
// accounts. Null when there is no key.
export function getStripeForCleanup(): Stripe | null {
  return client();
}

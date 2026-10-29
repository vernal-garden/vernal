import Stripe from 'stripe';
import { getServerConfig } from './serverConfig';

let instance: Stripe | null = null;

// Built on first use so a server running with BILLING=off never needs a key.
export function getStripe(): Stripe {
  if (getServerConfig().billing === 'off') {
    throw new Error('Stripe is not available: BILLING=off');
  }
  if (!instance) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error('STRIPE_SECRET_KEY environment variable is required');
    instance = new Stripe(key, { timeout: 15_000 });
  }
  return instance;
}

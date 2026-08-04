// client/src/config/pricing.ts
//
// Display copy for the Supporter pricing options. These numbers are
// PLACEHOLDERS — the Stripe Price objects referenced server-side by
// STRIPE_PRICE_MONTHLY / STRIPE_PRICE_ANNUAL / STRIPE_PRICE_LIFETIME are the
// source of truth for what a customer is actually charged. If these amounts
// are changed in Stripe, update this file to match.

export type Interval = 'monthly' | 'annual' | 'lifetime';

export interface PricingOption {
  interval: Interval;
  label: string;
  priceLabel: string;
  subLabel?: string;
  badge?: string;
}

export const PRICING: Record<Interval, PricingOption> = {
  monthly: {
    interval: 'monthly',
    label: 'Monthly',
    priceLabel: '$5/mo',
  },
  annual: {
    interval: 'annual',
    label: 'Annual',
    priceLabel: '$4/mo',
    subLabel: 'billed $48/yr — save ~20% vs. monthly',
  },
  lifetime: {
    interval: 'lifetime',
    label: 'Lifetime',
    priceLabel: '$150 once',
    subLabel: 'one-time payment, no renewal',
    badge: 'Early access',
  },
};

export const PRICING_ORDER: Interval[] = ['monthly', 'annual', 'lifetime'];

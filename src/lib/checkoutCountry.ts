import type { PoolClient } from 'pg';
import { db } from './db';
import { pacificParts } from './ownerAlerts';

// Paid checkout is US-only at launch. The territories count as US; DC is part of US.
export const CHECKOUT_COUNTRIES = ['US', 'PR', 'GU', 'VI', 'AS', 'MP'];

export function checkoutAllowed(code: string | null | undefined): boolean {
  if (!code) return false;
  return CHECKOUT_COUNTRIES.includes(code.trim().toUpperCase());
}

export type CheckoutPlan = 'monthly' | 'annual' | 'lifetime';
export type CheckKind =
  | 'before_checkout'
  | 'billing_address'
  | 'card_country'
  | 'address_change'
  | 'renewal';

// occurred_on is the Pacific date (pacificParts from ./ownerAlerts). country is
// upper-cased, or null when unknown. Pass a transaction's client to record inside it.
export async function recordCountryCheck(
  check: { country: string | null; plan: CheckoutPlan; kind: CheckKind },
  client?: PoolClient,
): Promise<void> {
  const country = check.country?.trim().toUpperCase().slice(0, 2) || null;
  await (client ?? db).query(
    'INSERT INTO checkout_country_checks (occurred_on, country, plan, check_kind) VALUES ($1, $2, $3, $4)',
    [pacificParts(new Date()).date, country, check.plan, check.kind],
  );
}

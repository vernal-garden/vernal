import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Stripe from 'stripe';
import type { ServerConfig } from './serverConfig';

const base: ServerConfig = { billing: 'stripe', mail: 'off', media: 'local', googleSignIn: false, weather: false };

// Fresh modules each time so the cached Stripe client never leaks between cases.
async function load(billing: ServerConfig['billing'], key: string) {
  vi.stubEnv('STRIPE_SECRET_KEY', key);
  const config = await import('./serverConfig');
  config.setServerConfigForTests({ ...base, billing });
  return import('./stripe');
}

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllEnvs());

describe('getStripeForCleanup', () => {
  it('returns a client with billing off, while getStripe refuses', async () => {
    const mod = await load('off', 'sk_test_dummy');
    expect(mod.getStripeForCleanup()).toBeInstanceOf(Stripe);
    expect(() => mod.getStripe()).toThrow('BILLING=off');
  });

  it.each(['', '   '])('returns null for the blank key %j', async (key) => {
    const mod = await load('off', key);
    expect(mod.getStripeForCleanup()).toBeNull();
  });

  it('shares one client with getStripe when billing is on', async () => {
    const mod = await load('stripe', 'sk_test_dummy');
    expect(mod.getStripeForCleanup()).toBe(mod.getStripe());
  });
});

import { test, expect } from '@playwright/test';
import Stripe from 'stripe';
import { resetTestDb, createTestUser, closePool } from './helpers/db';

test.beforeAll(resetTestDb);
test.afterAll(closePool);

test('checkout session returns a Stripe URL', async ({ request }) => {
  test.skip(!process.env.STRIPE_PRICE_MONTHLY, 'needs the Stripe test keys; runs on pushes to main');
  const user = await createTestUser({
    email: 'sub-user@example.com', password: 'Sub123456!'
  });
  await request.post('/api/auth/login',
    { data: { email: user.email, password: user.password } });
  const response = await request.post('/api/subscription/checkout',
    { data: { interval: 'monthly' } });
  expect(response.ok()).toBeTruthy();
  expect((await response.json()).url).toMatch(
    /^https:\/\/checkout\.stripe\.com\//
  );
});

test('stripe webhook: valid signature returns 200', async ({ request }) => {
  // Tests the HTTP contract only — DB-state changes are covered by
  // subscription.test.ts unit tests (Phase 24).
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
  const event = {
    id: `evt_test_${Date.now()}`,
    // An event type the handler ignores keeps this test off the Stripe API.
    type: 'customer.created',
    data: { object: { id: `cus_test_${Date.now()}`, object: 'customer' } },
  };
  const payload = JSON.stringify(event);
  const signature = stripe.webhooks.generateTestHeaderString({
    payload, secret: process.env.STRIPE_WEBHOOK_SECRET!,
  });
  const response = await request.post('/api/webhooks/stripe', {
    data: payload,
    headers: { 'stripe-signature': signature,
               'content-type': 'application/json' },
  });
  expect(response.status()).toBe(200);
  expect((await response.json()).received).toBe(true);
});

test('stripe webhook: invalid signature returns 400', async ({ request }) => {
  const response = await request.post('/api/webhooks/stripe', {
    data: JSON.stringify({ type: 'customer.subscription.updated' }),
    headers: { 'stripe-signature': 'bad-sig',
               'content-type': 'application/json' },
  });
  expect(response.status()).toBe(400);
});

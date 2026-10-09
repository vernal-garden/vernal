import { test, expect } from '@playwright/test';
import { resetTestDb, createTestUser, closePool } from './helpers/db';

test.beforeAll(resetTestDb);
test.afterAll(closePool);

test('fresh visitor can reach sign-in from onboarding step 1', async ({ page }) => {
  // '/' requires an existing garden (ProtectedRoute requireOnboarding), so a
  // fresh guest session is redirected to '/onboarding'.
  await page.goto('/');
  await expect(page).toHaveURL('/onboarding');

  const signIn = page.getByRole('link', { name: 'Sign in' });
  await expect(signIn).toBeVisible();
  await signIn.click();
  await expect(page).toHaveURL('/login');
});

test('sign-in link is shown on onboarding step 2', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL('/onboarding');

  await page.getByLabel('Location').fill('Richmond, VA');
  await page.getByLabel('Hardiness zone').fill('7b');
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByRole('heading', { name: 'How do you grow?' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
});

test('signed-in account without a garden does not see the sign-in link', async ({ page }) => {
  const user = await createTestUser({
    email: 'onboarding-account@example.com', password: 'Onboard123!'
  });
  await page.goto('/login');
  await page.fill('input[type="email"]', user.email);
  await page.fill('input[type="password"]', user.password);
  await page.click('button[type="submit"]');
  // createTestUser() never creates a garden, so '/' bounces to '/onboarding'.
  await expect(page).toHaveURL('/onboarding');

  await expect(page.getByRole('heading', { name: 'Where are you gardening?' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign in' })).toHaveCount(0);
});

import { test, expect, type Page } from '@playwright/test';
import { resetTestDb, createTestUser, closePool } from './helpers/db';

test.beforeAll(resetTestDb);
test.afterAll(closePool);

async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  // createTestUser() never creates a garden, so '/' bounces to '/onboarding'.
  await expect(page).toHaveURL('/onboarding');
}

// Signed out = a fresh guest session: the API reports no account, and the
// account-only /account route sends the visitor to /login.
async function expectSignedOut(page: Page): Promise<void> {
  const session = await page.request.get('/api/auth/session');
  const body = await session.json();
  expect(body.data.authenticated).toBe(false);
  expect(body.data.isGuest).toBe(true);

  await page.goto('/account');
  await expect(page).toHaveURL('/login');
}

// signOut() navigates to '/', but '/' requires an existing garden
// (ProtectedRoute requireOnboarding) and the new guest session has none, so
// the guard immediately redirects to '/onboarding'.
const SIGNED_OUT_LANDING = '/onboarding';

test('sign out from the account page', async ({ page }) => {
  const user = await createTestUser({ email: 'signout@example.com', password: 'SignOut123!' });
  await signIn(page, user.email, user.password);

  await page.goto('/account');
  await page.getByRole('button', { name: 'Sign out' }).click();

  await expect(page).toHaveURL(SIGNED_OUT_LANDING);
  await expectSignedOut(page);

  await page.reload();
  await expectSignedOut(page);
});

test('scheduling account deletion signs the user out', async ({ page }) => {
  const user = await createTestUser({ email: 'delete-me@example.com', password: 'DeleteMe123!' });
  await signIn(page, user.email, user.password);

  await page.goto('/account');
  await page.getByRole('button', { name: 'Data & Privacy' }).click();
  await page.getByRole('button', { name: 'Delete account' }).click();

  const dialog = page.getByRole('dialog', { name: 'Confirm account deletion' });
  await dialog.locator('input').fill('delete');
  await dialog.getByRole('button', { name: 'Delete account' }).click();

  await expect(page).toHaveURL(SIGNED_OUT_LANDING);
  await expectSignedOut(page);
});

import { test, expect } from '@playwright/test';
import { resetTestDb, createTestUser, closePool } from './helpers/db';

test.beforeAll(resetTestDb);
test.afterAll(closePool);

test('guest session is created on first visit', async ({ page }) => {
  await page.goto('/');
  // AuthContext bootstraps a guest session client-side (GET session -> miss ->
  // POST /api/auth/guest -> GET session again) before the route guards settle.
  await page.waitForLoadState('networkidle');
  const response = await page.request.get('/api/auth/session');
  const body = await response.json();
  expect(body.data.authenticated).toBe(false);
  expect(body.data.isGuest).toBe(true);
});

test('register a new account', async ({ page }) => {
  await page.goto('/register');
  await page.fill('input[type="email"]', 'newuser@example.com');
  await page.fill('input[type="password"]', 'MyPassword1!');
  await page.click('button[type="submit"]');
  // '/' requires an existing garden (ProtectedRoute requireOnboarding); a
  // freshly registered account has none, so it lands on /onboarding.
  await expect(page).toHaveURL('/onboarding');
});

test('login with valid credentials', async ({ page }) => {
  const user = await createTestUser({
    email: 'login-test@example.com', password: 'LoginPass1!'
  });
  await page.goto('/login');
  await page.fill('input[type="email"]', user.email);
  await page.fill('input[type="password"]', user.password);
  await page.click('button[type="submit"]');
  // createTestUser() never creates a garden, so the post-login redirect to
  // '/' immediately bounces to '/onboarding' (same requireOnboarding guard).
  await expect(page).toHaveURL('/onboarding');
  const session = await page.request.get('/api/auth/session');
  const body = await session.json();
  expect(body.data.authenticated).toBe(true);
  expect(body.data.account.email).toBe(user.email);
});

test('login with wrong password returns error', async ({ page }) => {
  const user = await createTestUser({ email: 'wrong-pass@example.com' });
  await page.goto('/login');
  await page.fill('input[type="email"]', user.email);
  await page.fill('input[type="password"]', 'NotTheRightOne');
  await page.click('button[type="submit"]');
  await expect(page.locator('text=Incorrect email or password')).toBeVisible();
});

test('logout clears session', async ({ page }) => {
  const user = await createTestUser({
    email: 'logout-test@example.com', password: 'Logout123!'
  });
  await page.goto('/login');
  await page.fill('input[type="email"]', user.email);
  await page.fill('input[type="password"]', user.password);
  await page.click('button[type="submit"]');
  await expect(page).toHaveURL('/onboarding');
  // There is no /api/auth/logout route — the session is cleared via DELETE /api/auth/session.
  await page.request.delete('/api/auth/session');
  const session = await page.request.get('/api/auth/session');
  expect((await session.json()).data.authenticated).toBe(false);
});

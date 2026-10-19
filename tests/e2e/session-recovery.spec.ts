import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { resetTestDb, createTestUser, deleteGuestSession, closePool } from './helpers/db';

test.beforeAll(resetTestDb);
test.afterAll(closePool);

async function sessionCookie(context: BrowserContext): Promise<string> {
  const cookie = (await context.cookies()).find((c) => c.name === '_vernal_sid');
  expect(cookie, 'session cookie').toBeTruthy();
  return cookie!.value;
}

// Simulates a browser that refuses this site's cookies. route.fetch() stores
// Set-Cookie in the context's jar itself, so the session cookie is cleared
// from the jar and stripped from the response before the page sees it.
async function blockSessionCookies(page: Page): Promise<void> {
  await page.route(/\/api\/auth\/(guest|login)$/, async (route) => {
    const response = await route.fetch();
    await page.context().clearCookies({ name: '_vernal_sid' });
    const headers = { ...response.headers() };
    delete headers['set-cookie'];
    await route.fulfill({ response, headers });
  });
}

test('a cookie whose session row is gone starts a fresh guest session', async ({ page, context }) => {
  await page.goto('/');
  await expect(page).toHaveURL('/onboarding');
  const stale = await sessionCookie(context);
  await deleteGuestSession(stale);

  await page.goto('/');
  await expect(page).toHaveURL('/onboarding');
  await expect(page.getByTestId('session-expired')).toHaveCount(0);
  expect(await sessionCookie(context)).not.toBe(stale);
});

test('a browser that blocks cookies is told so on first visit', async ({ page }) => {
  await blockSessionCookies(page);
  await page.goto('/');
  await expect(page).toHaveURL('/session-expired');
  await expect(page.getByTestId('session-cookies-blocked')).toBeVisible();
  await expect(page.getByTestId('session-expired')).toHaveCount(0);
});

test('logging in with cookies blocked shows the cookies message', async ({ page }) => {
  const user = await createTestUser({ email: 'blocked-cookies@example.com', password: 'Blocked123!' });
  await blockSessionCookies(page);
  await page.goto('/login');
  await page.fill('input[type="email"]', user.email);
  await page.fill('input[type="password"]', user.password);
  await page.click('button[type="submit"]');
  await expect(page.getByTestId('session-cookies-blocked')).toBeVisible();
});

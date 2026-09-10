import { test, expect } from '@playwright/test';

test('offline page is served when navigating offline',
    async ({ page, context }) => {
  test.skip(!process.env.CI, 'Offline test requires built PWA');
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await context.setOffline(true);
  await page.goto('/gardens', { waitUntil: 'domcontentloaded' });
  await expect(page.locator("text=You're offline")).toBeVisible();
  await context.setOffline(false);
});

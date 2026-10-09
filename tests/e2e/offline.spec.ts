import { test, expect } from '@playwright/test';

// Workbox navigateFallback is '/index.html' by design (Phase 31 ruling,
// 2026-08-18): an offline navigation on a previously visited install gets
// the precached app shell, not offline.html and not a browser error page.
test('offline navigation serves the precached app shell',
    async ({ page, context }) => {
  test.skip(!process.env.CI, 'Offline test requires built PWA');
  await page.goto('/');
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  if (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) {
    await page.reload();
  }
  expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);

  await context.setOffline(true);
  try {
    await page.goto('/gardens', { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveTitle('Vernal');
    await expect(page.locator('#root')).toBeAttached();
  } finally {
    await context.setOffline(false);
  }
});

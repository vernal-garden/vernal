import { test, expect, type Page } from '@playwright/test';
import { resetTestDb, closePool, setSubscriptionTier } from './helpers/db';
import { signIn } from './helpers/guide';
import { createMetricsFixture, type MetricsFixture } from './helpers/metrics';

// Runs only in the 'mobile' (Pixel 7) project — see playwright.config.ts.
test.describe.configure({ mode: 'serial' });

const EMAIL = 'metrics-mobile@example.com';
const PASSWORD = 'MetricsMobile123!';
const PLANT = 'Cherokee Tomato';

let fx: MetricsFixture;

test.beforeAll(async () => {
  await resetTestDb();
  fx = await createMetricsFixture(EMAIL, PASSWORD, PLANT);
});
test.afterAll(closePool);

test.beforeEach(async ({ page }) => {
  await signIn(page, EMAIL, PASSWORD);
});

async function expectNoHorizontalOverflow(page: Page, url: string): Promise<void> {
  await page.waitForLoadState('networkidle');
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth, `${url} overflows horizontally`).toBeLessThanOrEqual(innerWidth);
}

test('the Harvest page’s Data link opens /data in one column', async ({ page }) => {
  await page.goto('/harvest');
  await expect(page.getByTestId('harvest-card').first()).toBeVisible();
  await page.getByRole('link', { name: 'Data', exact: true }).tap();
  await expect(page).toHaveURL(/\/data$/);

  const totals = page.getByRole('region', { name: 'Harvest totals' });
  const recent = page.getByRole('region', { name: 'Recent activity' });
  await expect(totals).toContainText('500 g');
  await expect(recent).toBeVisible();
  const a = (await totals.boundingBox())!;
  const b = (await recent.boundingBox())!;
  expect(b.x).toBeCloseTo(a.x, 0);
  expect(b.width).toBeCloseTo(a.width, 0);
  expect(b.y).toBeGreaterThanOrEqual(a.y + a.height);
});

test('no horizontal page overflow on /data and /data/compare', async ({ page }) => {
  await page.goto('/data');
  await expect(page.getByRole('region', { name: 'Harvest totals' })).toContainText('500 g');
  await expectNoHorizontalOverflow(page, '/data');

  await setSubscriptionTier(fx.accountId, 'supporter');
  await page.goto('/data');
  await expect(page.getByRole('region', { name: 'Advanced analytics' })).toBeVisible();
  await expectNoHorizontalOverflow(page, '/data (supporter)');

  await page.goto(`/data/compare?plant=seed:${fx.seedId}`);
  await expect(page.getByRole('button', { name: `${fx.lastYear} · 400 g` })).toBeVisible();
  await expectNoHorizontalOverflow(page, '/data/compare');
});

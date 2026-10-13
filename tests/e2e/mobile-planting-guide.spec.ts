import { test, expect, type Page } from '@playwright/test';
import { resetTestDb, closePool } from './helpers/db';
import { createGuideFixture, signIn } from './helpers/guide';

// Runs only in the 'mobile' (Pixel 7) project — see playwright.config.ts.

const EMAIL = 'guide-mobile@example.com';
const PASSWORD = 'GuideMobile123!';

test.beforeAll(async () => {
  await resetTestDb();
  await createGuideFixture(EMAIL, PASSWORD);
});
test.afterAll(closePool);

test.beforeEach(async ({ page }) => {
  await signIn(page, EMAIL, PASSWORD);
});

const viewButton = (page: Page, name: string) =>
  page.getByRole('group', { name: 'View' }).getByRole('button', { name });

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
}

test('defaults to the list view', async ({ page }) => {
  await page.goto('/guide');
  await expect(viewButton(page, 'List')).toHaveAttribute('aria-pressed', 'true');
});

test('tapping a plant opens its schedule in a bottom sheet', async ({ page }) => {
  await page.goto('/guide');
  await page.getByTestId('guide-list-item')
    .filter({ hasText: 'Tomato' }).filter({ hasText: 'Start indoors' })
    .getByRole('button').click();
  const sheet = page.getByRole('dialog', { name: 'Tomato schedule' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('region', { name: 'Start indoors' })).toBeVisible();
  await sheet.getByRole('button', { name: 'Close' }).click();
  await expect(sheet).toHaveCount(0);
});

test('calendar shows three months and the arrows move the window', async ({ page }) => {
  await page.goto('/guide');
  await viewButton(page, 'Calendar').click();
  const months = page.getByTestId('calendar-month');
  await expect(months).toHaveCount(3);
  const before = await months.allTextContents();

  const next = page.getByRole('button', { name: 'Next month' });
  const arrow = (await next.isEnabled()) ? next : page.getByRole('button', { name: 'Previous month' });
  await arrow.click();
  await expect(months).toHaveCount(3);
  await expect.poll(() => months.allTextContents()).not.toEqual(before);
});

test('no horizontal page overflow', async ({ page }) => {
  await page.goto('/guide');
  await expect(viewButton(page, 'List')).toBeVisible();
  await expectNoHorizontalOverflow(page);
  for (const view of ['Calendar', 'Timeline']) {
    await viewButton(page, view).click();
    await expectNoHorizontalOverflow(page);
  }
});

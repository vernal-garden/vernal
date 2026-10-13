import { test, expect, request, type Page } from '@playwright/test';
import { resetTestDb, createTestUser, createTestGarden, createTestSeed, closePool } from './helpers/db';
import { addPlanting, currentSeason, signIn } from './helpers/guide';

// Runs only in the 'mobile' (Pixel 7) project — see playwright.config.ts.
test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:4173';
const EMAIL = 'harvest-mobile@example.com';
const PASSWORD = 'HarvestMobile123!';
const PLANT = 'Sugar Snap Pea';

test.beforeAll(async () => {
  await resetTestDb();
  const user = await createTestUser({ email: EMAIL, password: PASSWORD });
  const gardenId = await createTestGarden(user.id, 'Harvest Garden');
  const seedId = await createTestSeed(user.id, PLANT);
  const api = await request.newContext({ baseURL: BASE_URL });
  try {
    expect((await api.post('/api/auth/login', { data: { email: EMAIL, password: PASSWORD } })).ok()).toBe(true);
    await addPlanting(api, gardenId, currentSeason(), { seedId }, 0);
  } finally {
    await api.dispose();
  }
});
test.afterAll(closePool);

test.beforeEach(async ({ page }) => {
  await signIn(page, EMAIL, PASSWORD);
});

const tabBar = (page: Page) => page.getByRole('navigation', { name: 'Primary' });
const cards = (page: Page) => page.getByTestId('harvest-card');

test('the tab bar shows Harvest, not Weather, and marks it current', async ({ page }) => {
  await page.goto('/harvest');
  await expect(tabBar(page).getByRole('link', { name: 'Weather' })).toHaveCount(0);
  await expect(tabBar(page).getByRole('link', { name: 'Harvest' })).toHaveAttribute('aria-current', 'page');
});

test('the + button opens a full-screen form; saving shows a toast and the entry', async ({ page }) => {
  await page.goto('/harvest');
  // The empty state has its own "Log harvest" button; the floating + comes last.
  const plus = page.getByRole('button', { name: 'Log harvest' }).last();
  await expect(plus).toHaveText('+');
  await plus.tap();
  const form = page.getByRole('dialog', { name: 'Log harvest' });
  await expect(form.getByRole('heading', { name: 'Log harvest' })).toBeVisible();
  const box = await form.boundingBox();
  const viewport = page.viewportSize()!;
  expect(box!.width).toBe(viewport.width);
  expect(box!.height).toBe(viewport.height);

  await form.getByText('Choose a plant').tap();
  const sheet = page.getByRole('dialog', { name: 'Choose a plant' });
  await sheet.getByRole('searchbox', { name: 'Search plants' }).fill('Sugar');
  await sheet.getByRole('option', { name: new RegExp(PLANT) }).tap();
  await expect(sheet).toHaveCount(0);

  await form.getByLabel('Quantity').fill('12');
  await form.getByRole('button', { name: 'Count' }).tap();
  await form.getByRole('button', { name: 'Save', exact: true }).tap();
  await expect(page.getByRole('status').filter({ hasText: 'Harvest saved' })).toBeVisible();
  await expect(cards(page).filter({ hasText: PLANT })).toContainText('12 items');
});

test('an entry opens its detail with Back; Edit offers Delete harvest', async ({ page }) => {
  await page.goto('/harvest');
  await cards(page).first().tap();
  await expect(page).toHaveURL(/\/harvest\/\d+$/);
  await expect(page.getByRole('banner').getByRole('button', { name: 'Back' })).toBeVisible();
  await expect(page.getByRole('heading', { name: PLANT })).toBeVisible();

  await page.getByRole('button', { name: 'Edit', exact: true }).tap();
  const form = page.getByRole('dialog', { name: 'Edit harvest' });
  await expect(form.getByRole('button', { name: 'Delete harvest' })).toBeVisible();
});

test('no horizontal page overflow on /harvest', async ({ page }) => {
  await page.goto('/harvest');
  await expect(cards(page).first()).toBeVisible();
  await page.waitForLoadState('networkidle');
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
});

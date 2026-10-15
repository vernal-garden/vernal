import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { resetTestDb, createTestUser, createTestCambiumSeed, setGuestExpiry, closePool }
  from './helpers/db';

test.beforeAll(resetTestDb);
test.afterAll(closePool);

const SAVE_COPY =
  'Your garden is ready to save — create a free account to keep it and access it on any device.';

const banner = (page: Page) => page.getByTestId('guest-banner');

async function sessionCookie(context: BrowserContext): Promise<string> {
  const cookie = (await context.cookies()).find((c) => c.name === '_vernal_sid');
  expect(cookie, 'guest session cookie').toBeTruthy();
  return cookie!.value;
}

// A guest with a garden but nothing planted.
async function guestWithGarden(page: Page): Promise<string> {
  await page.goto('/onboarding');
  // The client mints the guest session asynchronously after first load.
  await expect.poll(async () => (await page.context().cookies())
    .some((c) => c.name === '_vernal_sid')).toBe(true);
  const resp = await page.request.post('/api/gardens', {
    data: { name: 'Guest Garden', style: 'grid', zone: '7b', growingMethod: 'raised_bed' },
  });
  expect(resp.status(), await resp.text()).toBe(201);
  return String((await resp.json()).id);
}

async function placePlanting(page: Page, gardenId: string, name: string): Promise<void> {
  const cambiumSeedId = await createTestCambiumSeed(name);
  const bedResp = await page.request.post(`/api/gardens/${gardenId}/beds`, {
    data: { type: 'grid', label: 'Guest Bed', grid: { x: 6, y: 8, cols: 4, rows: 4 } },
  });
  expect(bedResp.status(), await bedResp.text()).toBe(201);
  const bed = await bedResp.json();
  const plantingResp = await page.request.post(`/api/gardens/${gardenId}/beds/${bed.id}/plantings`, {
    data: { cambiumSeedId, quantity: 1, cell: { x: 1, y: 1 } },
  });
  expect(plantingResp.status(), await plantingResp.text()).toBe(201);
}

// The canvas fires this after a UI placement; the banner listens for it.
async function firePlacedEvent(page: Page): Promise<void> {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('vernal:planting-placed')));
}

test('new guest sees no banner until a plant is placed, then the save banner', async ({ page }) => {
  const gardenId = await guestWithGarden(page);
  await page.goto('/');
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('button', { name: 'Zoom in' })).toBeVisible();
  await page.waitForLoadState('networkidle');
  await expect(banner(page)).toHaveCount(0);

  await placePlanting(page, gardenId, 'Banner Basil A');
  await firePlacedEvent(page);
  await expect(banner(page)).toBeVisible();
  await expect(banner(page)).toHaveAttribute('data-state', 'save');
  await expect(banner(page)).toContainText(SAVE_COPY);
  await expect(page.getByTestId('guest-banner-create')).toBeVisible();
});

test('"Maybe later" reduces to a chip; a new browser context sees the full banner again', async ({
  page, browser,
}) => {
  const gardenId = await guestWithGarden(page);
  await page.goto('/');
  await placePlanting(page, gardenId, 'Banner Basil B');
  await firePlacedEvent(page);
  await expect(banner(page)).toHaveAttribute('data-state', 'save');

  await page.getByTestId('guest-banner-later').click();
  await expect(banner(page)).toHaveAttribute('data-state', 'reduced');
  await expect(page.getByTestId('guest-banner-chip')).toHaveText('Save your garden');
  await expect(banner(page)).not.toContainText(SAVE_COPY);

  // Reduced state lives in sessionStorage, so a fresh context starts prominent.
  const second = await browser.newContext();
  try {
    const page2 = await second.newPage();
    const gardenId2 = await guestWithGarden(page2);
    await placePlanting(page2, gardenId2, 'Banner Basil B2');
    await page2.goto('/');
    await expect(banner(page2)).toHaveAttribute('data-state', 'save');
    await expect(banner(page2)).toContainText(SAVE_COPY);
  } finally {
    await second.close();
  }
});

test('guest whose session expires in 5 days sees the warning banner', async ({ page, context }) => {
  const gardenId = await guestWithGarden(page);
  await placePlanting(page, gardenId, 'Banner Basil C');
  // ceil(4d23h / 1d) = 5
  await setGuestExpiry(await sessionCookie(context), '4 days 23 hours');
  await page.goto('/');
  await expect(banner(page)).toHaveAttribute('data-state', 'warning');
  await expect(banner(page)).toContainText('Your garden will be deleted in 5 days');
});

test('guest with a garden but no plantings still sees the 5-day warning', async ({ page, context }) => {
  await guestWithGarden(page);
  await setGuestExpiry(await sessionCookie(context), '4 days 23 hours');
  await page.goto('/');
  await expect(banner(page)).toHaveAttribute('data-state', 'warning');
  await expect(banner(page)).toContainText('Your garden will be deleted in 5 days');
});

test('signed-in accounts never see the banner', async ({ page }) => {
  const user = await createTestUser({ email: 'banner-account@example.com', password: 'Banner123!' });
  await page.goto('/login');
  await page.fill('input[type="email"]', user.email);
  await page.fill('input[type="password"]', user.password);
  await page.click('button[type="submit"]');
  await expect(page).not.toHaveURL(/\/login/);
  await page.goto('/gardens');
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  await expect(banner(page)).toHaveCount(0);
  await page.goto('/catalogue');
  await expect(banner(page)).toHaveCount(0);
});

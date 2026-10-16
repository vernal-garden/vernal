import { test, expect, request } from '@playwright/test';
import { resetTestDb, createTestUser, createTestGarden, createTestSeed, closePool } from './helpers/db';
import { currentSeason, signIn } from './helpers/guide';
import {
  MARKER_CELL, createCellPlanting, createGridBed, inspectPopover, openMarkerPopover,
} from './helpers/canvasSeasons';

// Phase 54 planting quantity, desktop. Runs in the 'chromium' project (the
// mobile half is mobile-planting-quantity.spec.ts — the 'mobile' project only
// matches mobile-*.spec.ts). Each scenario has its own account and garden; the
// first two tests share the planting of 16 and run in order.
test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:4173';
const PASSWORD = 'PlantingQty123!';
const PLANT = 'Cherokee Purple Tomato';
const OTHER_PLANT = 'Genovese Basil';
const BED_LABEL = 'Tomato Bed';
const COUNT_GARDEN = 'Count Garden';
// A cell in the same bed away from the marker cell (one planting per cell).
const OTHER_CELL = { x: 3, y: 3 };

const season = currentSeason();

const fx = {
  sixteen: { email: 'qty-sixteen@example.com', gardenId: '', plantingId: '' },
  one: { email: 'qty-one@example.com', gardenId: '' },
  count: { email: 'qty-count@example.com', gardenId: '' },
};

// An account with one garden holding one current-season grid bed; returns
// the garden and bed ids, with `api` logged in as the account.
async function setUp(email: string, gardenName: string) {
  const user = await createTestUser({ email, password: PASSWORD });
  const gardenId = await createTestGarden(user.id, gardenName);
  const seedId = await createTestSeed(user.id, PLANT);
  const otherSeedId = await createTestSeed(user.id, OTHER_PLANT);
  const api = await request.newContext({ baseURL: BASE_URL });
  expect((await api.post('/api/auth/login', { data: { email, password: PASSWORD } })).ok()).toBe(true);
  const bedId = await createGridBed(api, gardenId, season, BED_LABEL);
  return { api, gardenId, bedId, seedId, otherSeedId };
}

test.beforeAll(async () => {
  await resetTestDb();

  const a = await setUp(fx.sixteen.email, 'Sixteen Garden');
  try {
    fx.sixteen.gardenId = a.gardenId;
    fx.sixteen.plantingId = await createCellPlanting(a.api, a.gardenId, a.bedId, a.seedId, null, MARKER_CELL, 16);
  } finally {
    await a.api.dispose();
  }

  const b = await setUp(fx.one.email, 'One Garden');
  try {
    fx.one.gardenId = b.gardenId;
    await createCellPlanting(b.api, b.gardenId, b.bedId, b.seedId, null, MARKER_CELL, 1);
  } finally {
    await b.api.dispose();
  }

  const c = await setUp(fx.count.email, COUNT_GARDEN);
  try {
    fx.count.gardenId = c.gardenId;
    await createCellPlanting(c.api, c.gardenId, c.bedId, c.seedId, null, MARKER_CELL, 3);
    await createCellPlanting(c.api, c.gardenId, c.bedId, c.otherSeedId, null, OTHER_CELL, 1);
  } finally {
    await c.api.dispose();
  }
});
test.afterAll(closePool);

test('a planting of 16 shows 16 under Plants here', async ({ page }) => {
  await signIn(page, fx.sixteen.email, PASSWORD);
  await page.goto(`/?garden=${fx.sixteen.gardenId}`);
  await openMarkerPopover(page, PLANT);
  const popover = inspectPopover(page, PLANT);
  await expect(popover).toContainText('Plants here');
  await expect(popover.getByRole('textbox', { name: 'Plants here' })).toHaveValue('16');
  await expect(popover.getByRole('button', { name: 'Fewer plants' })).toBeEnabled();
  await expect(popover.getByRole('button', { name: 'More plants' })).toBeEnabled();
});

test('More plants three times saves 19 in one PATCH, kept after a reload', async ({ page }) => {
  await signIn(page, fx.sixteen.email, PASSWORD);
  await page.goto(`/?garden=${fx.sixteen.gardenId}`);
  await openMarkerPopover(page, PLANT);
  const popover = inspectPopover(page, PLANT);
  const input = popover.getByRole('textbox', { name: 'Plants here' });
  await expect(input).toHaveValue('16');

  const saved = page.waitForResponse(r =>
    r.request().method() === 'PATCH'
    && new URL(r.url()).pathname === `/api/plantings/${fx.sixteen.plantingId}`);
  const more = popover.getByRole('button', { name: 'More plants' });
  await more.click();
  await more.click();
  await more.click();
  await expect(input).toHaveValue('19');
  const resp = await saved;
  expect(resp.ok(), await resp.text()).toBe(true);
  expect(resp.request().postDataJSON()).toEqual({ quantity: 19 });

  await page.reload();
  await openMarkerPopover(page, PLANT);
  await expect(inspectPopover(page, PLANT).getByRole('textbox', { name: 'Plants here' })).toHaveValue('19');
});

test('a planting of 1 has Fewer plants disabled', async ({ page }) => {
  await signIn(page, fx.one.email, PASSWORD);
  await page.goto(`/?garden=${fx.one.gardenId}`);
  await openMarkerPopover(page, PLANT);
  const popover = inspectPopover(page, PLANT);
  await expect(popover.getByRole('textbox', { name: 'Plants here' })).toHaveValue('1');
  await expect(popover.getByRole('button', { name: 'Fewer plants' })).toBeDisabled();
  await expect(popover.getByRole('button', { name: 'More plants' })).toBeEnabled();
});

test('a bed with plantings of 3 and 1 counts 4 plants in its delete confirmation', async ({ page }) => {
  await signIn(page, fx.count.email, PASSWORD);
  await page.goto(`/?garden=${fx.count.gardenId}`);
  // Plantings must have loaded, or the bed would count as empty.
  await openMarkerPopover(page, PLANT);
  await inspectPopover(page, PLANT).getByRole('button', { name: 'Close' }).click();
  await expect(inspectPopover(page, PLANT)).toHaveCount(0);

  await page.getByRole('button', { name: 'Bed manager' }).click();
  await expect(page.getByText('4 plants', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Go to bed' }).click();
  await page.getByRole('button', { name: 'Delete bed' }).click();
  await expect(page.getByText('This bed has 4 plants. Deleting it will remove them too.')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
});

test('My Gardens shows 4 plants on that garden\'s card', async ({ page }) => {
  await signIn(page, fx.count.email, PASSWORD);
  await page.goto('/gardens');
  const card = page.getByRole('button', { name: `Open ${COUNT_GARDEN}` });
  await expect(card).toContainText('4 plants');
});

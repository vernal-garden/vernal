import { test, expect, request } from '@playwright/test';
import { resetTestDb, createTestUser, createTestGarden, createTestSeed, closePool } from './helpers/db';
import { currentSeason, signIn } from './helpers/guide';
import {
  MARKER_CELL, createCellPlanting, createGridBed, inspectPopover, openMarkerPopover,
} from './helpers/canvasSeasons';

// Phase 54 planting quantity on the view-only mobile canvas. Runs only in the
// 'mobile' (Pixel 7) project — see playwright.config.ts; the desktop half is
// planting-quantity.spec.ts.

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:4173';
const EMAIL = 'qty-mobile@example.com';
const PASSWORD = 'PlantingQty123!';
const PLANT = 'Cherokee Purple Tomato';

let gardenId: string;

test.beforeAll(async () => {
  await resetTestDb();
  const user = await createTestUser({ email: EMAIL, password: PASSWORD });
  gardenId = await createTestGarden(user.id, 'Mobile Quantity Garden');
  const seedId = await createTestSeed(user.id, PLANT);
  const api = await request.newContext({ baseURL: BASE_URL });
  try {
    expect((await api.post('/api/auth/login', { data: { email: EMAIL, password: PASSWORD } })).ok()).toBe(true);
    const bedId = await createGridBed(api, gardenId, currentSeason(), 'Tomato Bed');
    await createCellPlanting(api, gardenId, bedId, seedId, null, MARKER_CELL, 16);
  } finally {
    await api.dispose();
  }
});
test.afterAll(closePool);

test('a planting of 16 shows Plants here 16, with no stepper', async ({ page }) => {
  await signIn(page, EMAIL, PASSWORD);
  await page.goto(`/?garden=${gardenId}`);
  await openMarkerPopover(page, PLANT, { tap: true });

  const popover = inspectPopover(page, PLANT);
  await expect(popover).toContainText('Plants here');
  // The row: the label and the value as plain text.
  const row = popover.getByText('Plants here', { exact: true }).locator('..');
  await expect(row).toHaveText(/^Plants here\s*16$/);
  await expect(popover.getByRole('button', { name: 'More plants' })).toHaveCount(0);
  await expect(popover.getByRole('button', { name: 'Fewer plants' })).toHaveCount(0);
  await expect(popover.getByRole('textbox', { name: 'Plants here' })).toHaveCount(0);
});

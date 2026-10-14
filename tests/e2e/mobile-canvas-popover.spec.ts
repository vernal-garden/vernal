import { test, expect, request } from '@playwright/test';
import {
  resetTestDb, createTestUser, createTestGarden, createTestSeed, closePool, setPlantingHarvestReady,
} from './helpers/db';
import { currentSeason, signIn } from './helpers/guide';
import { createCellPlanting, createGridBed, inspectPopover, openMarkerPopover } from './helpers/canvasSeasons';

// Runs only in the 'mobile' (Pixel 7) project — see playwright.config.ts.

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:4173';
const EMAIL = 'canvas-popover-mobile@example.com';
const PASSWORD = 'CanvasPopover123!';
const PLANT = 'Cherokee Purple Tomato';

let gardenId: string;

test.beforeAll(async () => {
  await resetTestDb();
  const season = currentSeason();
  const user = await createTestUser({ email: EMAIL, password: PASSWORD });
  gardenId = await createTestGarden(user.id, 'Mobile Seasons Garden');
  const seedId = await createTestSeed(user.id, PLANT);
  const api = await request.newContext({ baseURL: BASE_URL });
  try {
    expect((await api.post('/api/auth/login', { data: { email: EMAIL, password: PASSWORD } })).ok()).toBe(true);
    const bedId = await createGridBed(api, gardenId, season, 'Tomato Bed');
    const plantingId = await createCellPlanting(api, gardenId, bedId, seedId, `${season}-01-02`);
    await setPlantingHarvestReady(plantingId);
  } finally {
    await api.dispose();
  }
});
test.afterAll(closePool);

test('tapping a marker opens the popover without Remove plant', async ({ page }) => {
  await signIn(page, EMAIL, PASSWORD);
  await page.goto(`/?garden=${gardenId}`);
  await openMarkerPopover(page, PLANT, { tap: true });

  const popover = inspectPopover(page, PLANT);
  await expect(popover).toContainText('Harvest-ready');
  await expect(popover.getByRole('link', { name: 'Log harvest' })).toBeVisible();
  await expect(popover.getByRole('button', { name: 'Mark as harvested' })).toBeVisible();
  await expect(popover.getByRole('button', { name: 'Close' })).toBeVisible();
  await expect(popover.getByRole('button', { name: 'Remove plant' })).toHaveCount(0);
});

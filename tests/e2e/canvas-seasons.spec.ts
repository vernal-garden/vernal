import { test, expect, request, type Page } from '@playwright/test';
import {
  resetTestDb, createTestUser, createTestGarden, createTestSeed, closePool, setPlantingHarvestReady,
} from './helpers/db';
import { currentSeason, signIn } from './helpers/guide';
import {
  createCellPlanting, createGridBed, inspectPopover, listBeds, openMarkerPopover,
} from './helpers/canvasSeasons';

// Desktop canvas seasons (Phase 50): new-season carry-forward prompt, the
// past-season overlay, and the marker inspection popover. The tests share one
// garden and build on each other, so they run in order.
test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:4173';
const EMAIL = 'canvas-seasons@example.com';
const PASSWORD = 'CanvasSeasons123!';
const PLANT = 'Cherokee Purple Tomato';
const BED_LABEL = 'Tomato Bed';

const thisYear = currentSeason();
const lastYear = thisYear - 1;

let gardenId: string;
let seedId: number;

test.beforeAll(async () => {
  await resetTestDb();
  const user = await createTestUser({ email: EMAIL, password: PASSWORD });
  gardenId = await createTestGarden(user.id, 'Seasons Garden');
  seedId = await createTestSeed(user.id, PLANT);
  const api = await request.newContext({ baseURL: BASE_URL });
  try {
    expect((await api.post('/api/auth/login', { data: { email: EMAIL, password: PASSWORD } })).ok()).toBe(true);
    // Last season only: one grid bed with one planting.
    const bedId = await createGridBed(api, gardenId, lastYear, BED_LABEL);
    await createCellPlanting(api, gardenId, bedId, seedId, `${lastYear}-05-01`);
  } finally {
    await api.dispose();
  }
});
test.afterAll(closePool);

test.beforeEach(async ({ page }) => {
  await signIn(page, EMAIL, PASSWORD);
});

const prompt = (page: Page) => page.getByRole('region', { name: 'New season, same garden?' });
const overlayStatus = (page: Page) => page.getByRole('status').filter({ hasText: /overlay/ });

test('the new-season prompt brings last season\'s beds forward and shows the overlay', async ({ page }) => {
  await page.goto(`/?garden=${gardenId}`);
  await expect(prompt(page)).toBeVisible();
  await expect(prompt(page)).toContainText(
    `Bring your beds forward from ${lastYear}. Your plants stay with ${lastYear}.`,
  );
  await expect(prompt(page).getByRole('button', { name: 'Start fresh' })).toBeVisible();

  await prompt(page).getByRole('button', { name: 'Bring beds forward' }).click();
  await expect(prompt(page)).toHaveCount(0);
  await expect(overlayStatus(page)).toHaveText(`Showing ${lastYear} overlay`);
  await expect(page.getByRole('combobox', { name: 'Season overlay' })).toHaveValue(String(lastYear));

  // The layout was copied into this season; the planting stayed behind.
  const beds = await listBeds(page.request, gardenId, thisYear);
  expect(beds.map(b => b.label)).toEqual([BED_LABEL]);
  const plantings = await (await page.request.get(`/api/gardens/${gardenId}/plantings?season=${thisYear}`)).json();
  expect(plantings.data).toHaveLength(0);

  // Clear turns the overlay off.
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(overlayStatus(page)).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Season overlay' })).toHaveValue('current');

  // This season has beds now, so a reload asks nothing.
  await page.reload();
  const select = page.getByRole('combobox', { name: 'Season overlay' });
  await expect(select).toBeVisible();
  await expect(select.getByRole('option', { name: `This season (${thisYear})` })).toHaveCount(1);
  await expect(prompt(page)).toHaveCount(0);
  await expect(overlayStatus(page)).toHaveCount(0);
});

test('choosing a past season in the select shows its overlay; Clear removes it', async ({ page }) => {
  await page.goto(`/?garden=${gardenId}`);
  const select = page.getByRole('combobox', { name: 'Season overlay' });
  await select.selectOption(String(lastYear));
  await expect(overlayStatus(page)).toHaveText(`Showing ${lastYear} overlay`);
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(overlayStatus(page)).toHaveCount(0);
});

test('a harvest-ready marker offers Log harvest and Mark as harvested', async ({ page }) => {
  const [bed] = await listBeds(page.request, gardenId, thisYear);
  const plantingId = await createCellPlanting(page.request, gardenId, bed.id, seedId, `${thisYear}-01-02`);
  await setPlantingHarvestReady(plantingId);

  await page.goto(`/?garden=${gardenId}`);
  await openMarkerPopover(page, PLANT);
  const popover = inspectPopover(page, PLANT);
  await expect(popover).toContainText('Harvest-ready');
  await expect(popover).toContainText('Planted Jan 2');
  await expect(popover.getByRole('button', { name: 'Mark as harvested' })).toBeVisible();
  await expect(popover.getByRole('button', { name: 'Remove plant' })).toBeVisible();

  const logLink = popover.getByRole('link', { name: 'Log harvest' });
  await expect(logLink).toHaveAttribute('href', `/harvest?log=new&gardenId=${gardenId}&seed=seed:${seedId}`);
  await logLink.click();
  await expect(page).toHaveURL(/\/harvest\?/);
  const form = page.getByRole('dialog', { name: 'Log harvest' });
  await expect(form.getByText(PLANT, { exact: true })).toBeVisible();
  await expect(form.getByRole('combobox', { name: 'Plant' })).toHaveCount(0);
});

test('Mark as harvested removes the option on the next open', async ({ page }) => {
  await page.goto(`/?garden=${gardenId}`);
  await openMarkerPopover(page, PLANT);
  const popover = inspectPopover(page, PLANT);

  const dismissed = page.waitForResponse(r =>
    r.request().method() === 'PATCH' && /\/api\/plantings\/\d+$/.test(r.url()));
  await popover.getByRole('button', { name: 'Mark as harvested' }).click();
  expect((await dismissed).ok()).toBe(true);
  await expect(popover.getByRole('button', { name: 'Mark as harvested' })).toHaveCount(0);

  await popover.getByRole('button', { name: 'Close' }).click();
  await expect(popover).toHaveCount(0);
  await openMarkerPopover(page, PLANT);
  await expect(popover).toContainText('Harvest-ready');
  await expect(popover.getByRole('link', { name: 'Log harvest' })).toBeVisible();
  await expect(popover.getByRole('button', { name: 'Mark as harvested' })).toHaveCount(0);

  // And it stays dismissed after a reload.
  await page.reload();
  await openMarkerPopover(page, PLANT);
  await expect(popover.getByRole('link', { name: 'Log harvest' })).toBeVisible();
  await expect(popover.getByRole('button', { name: 'Mark as harvested' })).toHaveCount(0);
});

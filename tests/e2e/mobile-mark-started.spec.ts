import { test, expect, request, type Page } from '@playwright/test';
import { resetTestDb, createTestUser, createTestGarden, createTestSeed, closePool } from './helpers/db';
import { currentSeason, signIn } from './helpers/guide';
import { createCellPlanting, createGridBed, inspectPopover, openMarkerPopover } from './helpers/canvasSeasons';

// Runs only in the 'mobile' (Pixel 7) project — see playwright.config.ts.
// Phase 76b follow-up: on phones, a planned planting's popover opens the bulk
// "What's in the ground?" sheet for its bed.

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:4173';
const EMAIL = 'mark-started-mobile@example.com';
const PASSWORD = 'MarkStarted123!';

const TOMATO = 'Cherokee Purple Tomato'; // planned, transplanted
const BASIL = 'Genovese Basil'; // planned, sown
const PEA = 'Sugar Snap Pea'; // growing

const TOMATO_CELL = { x: 1, y: 1 };
const BASIL_CELL = { x: 2, y: 1 };
const PEA_CELL = { x: 1, y: 2 };

const BULK_LINK = 'Mark plants in the ground';
const SHEET_TITLE = "What's in the ground?";

let gardenId: string;

// Fresh account, garden and plantings for every test, so order doesn't matter.
test.beforeEach(async () => {
  await resetTestDb();
  const season = currentSeason();
  const user = await createTestUser({ email: EMAIL, password: PASSWORD });
  gardenId = await createTestGarden(user.id, 'Mobile Mark Garden');
  const tomatoId = await createTestSeed(user.id, TOMATO);
  const basilId = await createTestSeed(user.id, BASIL);
  const peaId = await createTestSeed(user.id, PEA);
  const api = await request.newContext({ baseURL: BASE_URL });
  try {
    expect((await api.post('/api/auth/login', { data: { email: EMAIL, password: PASSWORD } })).ok()).toBe(true);
    const bedId = await createGridBed(api, gardenId, season, 'Mixed Bed');
    await createCellPlanting(api, gardenId, bedId, tomatoId, null, TOMATO_CELL, 1,
      { state: 'planned', startMethod: 'transplanted' });
    await createCellPlanting(api, gardenId, bedId, basilId, null, BASIL_CELL, 1,
      { state: 'planned', startMethod: 'sown' });
    await createCellPlanting(api, gardenId, bedId, peaId, `${season}-01-02`, PEA_CELL);
  } finally {
    await api.dispose();
  }
});
test.afterAll(closePool);

const markSheet = (page: Page) => page.getByRole('dialog', { name: SHEET_TITLE });

async function openGarden(page: Page): Promise<void> {
  await signIn(page, EMAIL, PASSWORD);
  await page.goto(`/?garden=${gardenId}`);
}

async function openSheetFromTomato(page: Page): Promise<void> {
  await openMarkerPopover(page, TOMATO, { tap: true, cell: TOMATO_CELL });
  await inspectPopover(page, TOMATO).getByRole('button', { name: BULK_LINK }).tap();
  await expect(markSheet(page)).toBeVisible();
}

async function closePopover(page: Page, plant: string): Promise<void> {
  const popover = inspectPopover(page, plant);
  await popover.getByRole('button', { name: 'Close' }).tap();
  await expect(popover).toHaveCount(0);
}

test('a planned popover opens the bed sheet listing only planned plants', async ({ page }) => {
  await openGarden(page);
  await openMarkerPopover(page, TOMATO, { tap: true, cell: TOMATO_CELL });
  const popover = inspectPopover(page, TOMATO);
  const link = popover.getByRole('button', { name: BULK_LINK });
  await expect(link).toBeVisible();

  await link.tap();
  await expect(popover).toHaveCount(0);
  const sheet = markSheet(page);
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('checkbox')).toHaveCount(2);
  await expect(sheet.getByRole('checkbox', { name: new RegExp(TOMATO) })).toBeChecked();
  await expect(sheet.getByRole('checkbox', { name: new RegExp(BASIL) })).toBeChecked();
  await expect(sheet).not.toContainText(PEA);
});

test('saving marks only the checked plant', async ({ page }) => {
  await openGarden(page);
  await openSheetFromTomato(page);
  const sheet = markSheet(page);
  await sheet.getByRole('checkbox', { name: new RegExp(BASIL) }).uncheck();
  await sheet.getByRole('button', { name: 'Mark 1 in the ground' }).tap();
  await expect(sheet).toHaveCount(0);

  await openMarkerPopover(page, TOMATO, { tap: true, cell: TOMATO_CELL });
  const tomato = inspectPopover(page, TOMATO);
  await expect(tomato).not.toContainText('Planned ·');
  await expect(tomato.getByRole('button', { name: BULK_LINK })).toHaveCount(0);
  await closePopover(page, TOMATO);

  await openMarkerPopover(page, BASIL, { tap: true, cell: BASIL_CELL });
  await expect(inspectPopover(page, BASIL)).toContainText('Planned · sowing seed');
});

test('with every plant unchecked the save button is disabled', async ({ page }) => {
  await openGarden(page);
  await openSheetFromTomato(page);
  const sheet = markSheet(page);
  await sheet.getByRole('checkbox', { name: new RegExp(TOMATO) }).uncheck();
  await sheet.getByRole('checkbox', { name: new RegExp(BASIL) }).uncheck();
  await expect(sheet.getByRole('button', { name: 'Choose plants to mark' })).toBeDisabled();
});

test('a growing popover has no bulk mark button', async ({ page }) => {
  await openGarden(page);
  await openMarkerPopover(page, PEA, { tap: true, cell: PEA_CELL });
  const popover = inspectPopover(page, PEA);
  await expect(popover.getByRole('button', { name: 'Close' })).toBeVisible();
  await expect(popover.getByRole('button', { name: BULK_LINK })).toHaveCount(0);
});

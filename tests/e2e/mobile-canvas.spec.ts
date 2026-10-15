import { test, expect, request, type Locator, type Page } from '@playwright/test';
import {
  resetTestDb, createTestUser, createTestGarden, createTestSeed, setSeedSpacing, closePool,
} from './helpers/db';
import { currentSeason, signIn } from './helpers/guide';
import { createCellPlanting } from './helpers/canvasSeasons';
import {
  canvasScreenPoint, cellCenter, createFreeformBed, createGridBedAt, describeRect, gridBedScreenRect,
  pointsScreenRect, rectPoints, rectWithin, requireStageView, stageView, type Point, type ScreenRect,
} from './helpers/canvasStage';

// Phase 53 view-only mobile canvas. Runs only in the 'mobile' (Pixel 7)
// project — see playwright.config.ts.

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:4173';
const EMAIL = 'mobile-canvas@example.com';
const PASSWORD = 'MobileCanvas123!';
const PLANT = 'Sungold Tomato';
const SPACING_IN = 18;

const thisYear = currentSeason();
const lastYear = thisYear - 1;

// Two current-season beds side by side, 600 px apart in world space: wider
// than a Pixel 7 at scale 1, so both are on screen only if the canvas fitted.
const GRID_BED = { label: 'Tomato Bed', grid: { x: 0, y: 0, cols: 4, rows: 4 } };
const MARKER_CELL = { x: 1, y: 1 };
// Same bed, two cells diagonally from the marker: well outside its hit radius.
const EMPTY_CELL = { x: 3, y: 3 };
const FREEFORM_BED = { label: 'Herb Patch', points: rectPoints(600, 0, 720, 120) };

let gardenId: string;

test.beforeAll(async () => {
  await resetTestDb();
  const user = await createTestUser({ email: EMAIL, password: PASSWORD });
  gardenId = await createTestGarden(user.id, 'Mobile Canvas Garden');
  const seedId = await createTestSeed(user.id, PLANT);
  await setSeedSpacing(seedId, SPACING_IN);
  const api = await request.newContext({ baseURL: BASE_URL });
  try {
    expect((await api.post('/api/auth/login', { data: { email: EMAIL, password: PASSWORD } })).ok()).toBe(true);
    const bedId = await createGridBedAt(api, gardenId, thisYear, GRID_BED.label, GRID_BED.grid);
    await createCellPlanting(api, gardenId, bedId, seedId, null, MARKER_CELL);
    await createFreeformBed(api, gardenId, thisYear, FREEFORM_BED.label, FREEFORM_BED.points);
    // A last-season layout, so the season sheet has an overlay option.
    await createGridBedAt(api, gardenId, lastYear, 'Old Bed', { x: 0, y: 6, cols: 3, rows: 3 });
  } finally {
    await api.dispose();
  }
});
test.afterAll(closePool);

test.beforeEach(async ({ page }) => {
  await signIn(page, EMAIL, PASSWORD);
  await page.goto(`/?garden=${gardenId}`);
  await expect(page.getByRole('button', { name: 'Zoom in' })).toBeVisible();
});

// The band between the mobile top bar and the bottom tab bar.
async function visibleBand(page: Page): Promise<ScreenRect> {
  const top = await page.getByRole('banner').boundingBox();
  const tabs = await page.getByRole('navigation', { name: 'Primary' }).boundingBox();
  expect(top).not.toBeNull();
  expect(tabs).not.toBeNull();
  const width = await page.evaluate(() => window.innerWidth);
  return { left: 0, top: top!.y + top!.height, right: width, bottom: tabs!.y };
}

async function bedRects(page: Page): Promise<{ grid: ScreenRect; freeform: ScreenRect } | null> {
  const view = await stageView(page);
  if (!view) return null;
  return { grid: gridBedScreenRect(view, GRID_BED.grid), freeform: pointsScreenRect(view, FREEFORM_BED.points) };
}

// Taps a world point until `dialog` is open. Single taps are only acted on
// after the 300 ms double-tap window; each retry waits well past it, so two
// retries never combine into a double-tap. A tap that lands before the
// plantings load opens the bed popover instead — the next tap closes it and
// the one after reopens the right one.
async function tapUntilOpen(page: Page, world: Point, dialog: Locator): Promise<void> {
  await expect(async () => {
    if (!(await dialog.isVisible())) {
      const { x, y } = await canvasScreenPoint(page, world);
      await page.touchscreen.tap(x, y);
    }
    await expect(dialog).toBeVisible({ timeout: 1_500 });
  }).toPass({ timeout: 15_000 });
}

test('on open both beds are fitted inside the visible area', async ({ page }) => {
  const band = await visibleBand(page);
  await expect.poll(async () => {
    const rects = await bedRects(page);
    if (!rects) return 'no stage';
    const out = [];
    if (!rectWithin(rects.grid, band)) out.push(`grid bed ${describeRect(rects.grid)}`);
    if (!rectWithin(rects.freeform, band)) out.push(`freeform bed ${describeRect(rects.freeform)}`);
    return out.length ? `outside ${describeRect(band)}: ${out.join('; ')}` : 'ok';
  }, { timeout: 10_000 }).toBe('ok');
});

test('no editing controls render on mobile', async ({ page }) => {
  // Desktop toolbar: Grid / Freeform mode buttons, pan tool, bed manager,
  // reset-zoom readout, season select; plus the plant picker and bed panel.
  await expect(page.getByRole('button', { name: 'Add bed' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Grid', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Freeform', exact: true })).toHaveCount(0);
  await expect(page.getByTitle(/bed mode$/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Beds?$|^Bed manager$/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Pan tool/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Reset zoom/ })).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Season overlay' })).toHaveCount(0);
  await expect(page.getByPlaceholder('Search plants…')).toHaveCount(0);
  await expect(page.getByText('Add plant to', { exact: true })).toHaveCount(0);
});

test('the editing note shows and Dismiss hides it for the session', async ({ page }) => {
  const note = page.getByRole('note', { name: 'Editing note' });
  await expect(note).toBeVisible();
  await note.getByRole('button', { name: 'Dismiss' }).tap();
  await expect(note).toHaveCount(0);
  expect(await page.evaluate(() => window.sessionStorage.getItem('vernal.canvas.mobileNote'))).toBe('1');

  await page.reload();
  await expect(page.getByRole('button', { name: 'Zoom in' })).toBeVisible();
  await expect(page.getByRole('note', { name: 'Editing note' })).toHaveCount(0);
});

test('tapping the marker opens the plant popover with its spacing', async ({ page }) => {
  const popover = page.getByRole('dialog', { name: PLANT });
  await tapUntilOpen(page, cellCenter(GRID_BED.grid, MARKER_CELL), popover);
  await expect(popover).toContainText(`${SPACING_IN} in. spacing`);
  await expect(popover.getByRole('button', { name: 'Remove plant' })).toHaveCount(0);
  await popover.getByRole('button', { name: 'Close' }).tap();
  await expect(popover).toHaveCount(0);
});

test('tapping inside a bed away from the marker opens the bed popover', async ({ page }) => {
  // Plantings must be loaded, or the bed would report itself empty.
  await tapUntilOpen(page, cellCenter(GRID_BED.grid, MARKER_CELL), page.getByRole('dialog', { name: PLANT }));
  await page.getByRole('dialog', { name: PLANT }).getByRole('button', { name: 'Close' }).tap();

  const gridPopover = page.getByRole('dialog', { name: GRID_BED.label });
  await tapUntilOpen(page, cellCenter(GRID_BED.grid, EMPTY_CELL), gridPopover);
  await expect(page.getByRole('dialog', { name: PLANT })).toHaveCount(0);
  await expect(gridPopover).toContainText('Grid');
  await expect(gridPopover).toContainText('1 plant');
  await gridPopover.getByRole('button', { name: 'Close' }).tap();
  await expect(gridPopover).toHaveCount(0);

  const freeformPopover = page.getByRole('dialog', { name: FREEFORM_BED.label });
  await tapUntilOpen(page, { x: 660, y: 60 }, freeformPopover);
  await expect(freeformPopover).toContainText('Freeform');
  await expect(freeformPopover).toContainText('Empty');
});

test('Zoom in and Zoom out change the stage scale', async ({ page }) => {
  // Wait for the fit to settle (both beds in view) before reading the scale.
  const band = await visibleBand(page);
  await expect.poll(async () => {
    const rects = await bedRects(page);
    return !!rects && rectWithin(rects.grid, band) && rectWithin(rects.freeform, band);
  }, { timeout: 10_000 }).toBe(true);
  const fitted = (await requireStageView(page)).scale;

  await page.getByRole('button', { name: 'Zoom in' }).tap();
  await expect.poll(async () => (await requireStageView(page)).scale).toBeGreaterThan(fitted * 1.05);
  const zoomed = (await requireStageView(page)).scale;

  await page.getByRole('button', { name: 'Zoom out' }).tap();
  await expect.poll(async () => (await requireStageView(page)).scale).toBeLessThan(zoomed * 0.95);
});

test('the season pill opens the season sheet', async ({ page }) => {
  const pill = page.getByRole('button', { name: 'Season: This season' });
  await expect(pill).toBeVisible();
  await expect(pill).toHaveAttribute('aria-haspopup', 'dialog');
  await pill.tap();

  const sheet = page.getByRole('dialog', { name: 'Choose season' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('button', { name: `This season (${thisYear})` })).toBeVisible();
  const overlayOption = sheet.getByRole('button', { name: `${lastYear} overlay` });
  await expect(overlayOption).toBeVisible();

  await overlayOption.tap();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByRole('button', { name: `Season: ${lastYear} overlay` })).toBeVisible();
});

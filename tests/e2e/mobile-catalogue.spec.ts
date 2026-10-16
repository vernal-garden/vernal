import { test, expect, type Locator, type Page } from '@playwright/test';
import {
  resetTestDb, createTestUser, createTestGarden, createTestSeed, createTestCambiumSeed,
  deleteCambiumSeedsLike, closePool,
} from './helpers/db';
import { signIn } from './helpers/guide';

// Phase 53 mobile catalogue: one-column list and the read-only seed detail.
// Runs only in the 'mobile' (Pixel 7) project — see playwright.config.ts.

const EMAIL = 'mobile-catalogue@example.com';
const PASSWORD = 'MobileCatalogue123!';
const DESKTOP_NOTE = 'To add, edit, or suggest a correction, visit Vernal on desktop.';

// cambium.seeds survives resetTestDb, so the names carry a per-run stamp and
// the list is narrowed to them by search. afterAll deletes every 'Mobcat %'
// seed, which also clears leftovers from earlier runs.
const STAMP_PREFIX = 'Mobcat ';
const STAMP = `${STAMP_PREFIX}${Date.now()}`;
const CAMBIUM_NAMES = [`${STAMP} Alpha`, `${STAMP} Bravo`, `${STAMP} Charlie`];
const PERSONAL_NAME = 'Mobile Personal Pepper';

let personalSeedId: number;
const cambiumIds: number[] = [];

test.beforeAll(async () => {
  await resetTestDb();
  const user = await createTestUser({ email: EMAIL, password: PASSWORD });
  await createTestGarden(user.id, 'Catalogue Garden');
  for (const name of CAMBIUM_NAMES) cambiumIds.push(await createTestCambiumSeed(name));
  personalSeedId = await createTestSeed(user.id, PERSONAL_NAME);
});
test.afterAll(async () => {
  await deleteCambiumSeedsLike(`${STAMP_PREFIX}%`);
  await closePool();
});

test.beforeEach(async ({ page }) => {
  await signIn(page, EMAIL, PASSWORD);
});

const seedList = (page: Page) => page.getByRole('list', { name: 'Seeds' });

// react-router's history stack index (history.state.idx): equal before an
// open and after a close means the close left no extra entry behind.
const historyIdx = (page: Page) =>
  page.evaluate(() => (window.history.state as { idx?: number } | null)?.idx ?? 0);

async function searchStamped(page: Page): Promise<Locator> {
  await page.goto('/catalogue');
  await page.getByRole('searchbox', { name: 'Search seeds' }).fill(STAMP);
  const list = seedList(page);
  await expect(list.getByRole('listitem')).toHaveCount(CAMBIUM_NAMES.length);
  return list;
}

// Everything the mobile detail must not offer (desktop-only actions).
async function expectReadOnlyDetail(detail: Locator): Promise<void> {
  const note = detail.getByTestId('seed-detail-desktop-note');
  // The note renders with the loaded detail, so wait for it before checking absences.
  await expect(note).toBeVisible();
  await expect(note).toHaveText(DESKTOP_NOTE);
  await expect(detail.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
  await expect(detail.getByRole('button', { name: 'Suggest a correction' })).toHaveCount(0);
  await expect(detail.getByRole('button', { name: /Add to my catalogue/ })).toHaveCount(0);
  await expect(detail.getByRole('button', { name: 'Add to Garden' })).toHaveCount(0);
  await expect(detail.getByText('Suggest a correction', { exact: true })).toHaveCount(0);
  await expect(detail.getByText('Add to Garden', { exact: true })).toHaveCount(0);
}

test('the catalogue is a one-column list', async ({ page }) => {
  const list = await searchStamped(page);
  const listBox = await list.boundingBox();
  expect(listBox).not.toBeNull();

  const rows = list.getByRole('listitem').getByRole('button');
  await expect(rows).toHaveCount(CAMBIUM_NAMES.length);
  const boxes = [];
  for (let i = 0; i < CAMBIUM_NAMES.length; i++) {
    const box = await rows.nth(i).boundingBox();
    expect(box, `row ${i} has no box`).not.toBeNull();
    boxes.push(box!);
  }
  for (const [i, box] of boxes.entries()) {
    expect(Math.abs(box.x - boxes[0].x), `row ${i} x`).toBeLessThanOrEqual(1);
    expect(Math.abs(box.width - listBox!.width), `row ${i} width vs list`).toBeLessThanOrEqual(1);
    if (i > 0) expect(box.y, `row ${i} is below row ${i - 1}`).toBeGreaterThanOrEqual(boxes[i - 1].y + boxes[i - 1].height - 1);
  }
  // Each row's name starts with the seed's common name.
  for (const name of CAMBIUM_NAMES) {
    await expect(list.getByRole('button', { name: new RegExp(`^${name}`) })).toBeVisible();
  }
});

test('Filter opens the Filters sheet', async ({ page }) => {
  await page.goto('/catalogue');
  await page.getByRole('button', { name: 'Filter', exact: true }).tap();
  await expect(page.getByRole('dialog', { name: 'Filters' })).toBeVisible();
});

test('a community seed opens read-only with the desktop note', async ({ page }) => {
  const list = await searchStamped(page);
  const name = CAMBIUM_NAMES[0];
  await list.getByRole('button', { name: new RegExp(`^${name}`) }).tap();

  const detail = page.getByRole('dialog', { name });
  await expect(detail).toBeVisible();
  await expectReadOnlyDetail(detail);

  await detail.getByRole('button', { name: 'Close' }).tap();
  await expect(detail).toHaveCount(0);
});

test('a personal seed opens read-only with the desktop note', async ({ page }) => {
  await page.goto(`/catalogue?open=seed:${personalSeedId}`);
  const detail = page.getByRole('dialog', { name: PERSONAL_NAME });
  await expect(detail).toBeVisible();
  await expectReadOnlyDetail(detail);
  // The one-shot ?open= link becomes the ?seed= param in place.
  await expect(page).toHaveURL(new RegExp(`[?&]seed=seed(:|%3A)${personalSeedId}$`));
});

test('back closes the seed detail and stays on the catalogue', async ({ page }) => {
  const list = await searchStamped(page);
  const name = CAMBIUM_NAMES[1];
  await list.getByRole('button', { name: new RegExp(`^${name}`) }).tap();
  const detail = page.getByRole('dialog', { name });
  await expect(detail).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`[?&]seed=cambium(:|%3A)${cambiumIds[1]}$`));

  await page.goBack();
  await expect(detail).toHaveCount(0);
  const url = new URL(page.url());
  expect(url.pathname).toBe('/catalogue');
  expect(url.searchParams.has('seed')).toBe(false);
  // The search survives: same query, same rows.
  await expect(page.getByRole('searchbox', { name: 'Search seeds' })).toHaveValue(STAMP);
  await expect(list.getByRole('listitem')).toHaveCount(CAMBIUM_NAMES.length);
});

test('closing with X leaves no extra history entry', async ({ page }) => {
  const list = await searchStamped(page);
  const before = await historyIdx(page);
  const name = CAMBIUM_NAMES[2];
  await list.getByRole('button', { name: new RegExp(`^${name}`) }).tap();
  const detail = page.getByRole('dialog', { name });
  await expect(detail).toBeVisible();

  await detail.getByRole('button', { name: 'Close' }).tap();
  await expect(detail).toHaveCount(0);
  await expect(page).not.toHaveURL(/[?&]seed=/);
  expect(await historyIdx(page)).toBe(before);
  await expect(page.getByRole('searchbox', { name: 'Search seeds' })).toHaveValue(STAMP);
});

test('a direct ?seed= link opens the seed; X removes the param in place', async ({ page }) => {
  await page.goto(`/catalogue?seed=cambium:${cambiumIds[0]}`);
  const detail = page.getByRole('dialog', { name: CAMBIUM_NAMES[0] });
  await expect(detail).toBeVisible();
  const before = await historyIdx(page);

  await detail.getByRole('button', { name: 'Close' }).tap();
  await expect(detail).toHaveCount(0);
  const url = new URL(page.url());
  expect(url.pathname).toBe('/catalogue');
  expect(url.searchParams.has('seed')).toBe(false);
  expect(await historyIdx(page)).toBe(before);
});

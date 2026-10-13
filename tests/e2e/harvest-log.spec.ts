import { test, expect, request, type Page } from '@playwright/test';
import { resetTestDb, createTestUser, createTestGarden, createTestSeed, closePool } from './helpers/db';
import { addPlanting, currentSeason, signIn } from './helpers/guide';

// Desktop harvest log (Harvest Log spec 6.2 / 6.3) and its micro-feedback prompt.
// The tests share one account and build on each other, so they run in order.
test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:4173';
const EMAIL = 'harvest-desktop@example.com';
const PASSWORD = 'HarvestDesk123!';
const PLANT = 'Sugar Snap Pea';

let gardenId: string;
let seedId: number;

// "October 2026" for today in America/Los_Angeles, as the list headers read.
function currentMonthLabel(): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', month: 'long', year: 'numeric' })
    .format(new Date());
}

test.beforeAll(async () => {
  await resetTestDb();
  const user = await createTestUser({ email: EMAIL, password: PASSWORD });
  gardenId = await createTestGarden(user.id, 'Harvest Garden');
  seedId = await createTestSeed(user.id, PLANT);
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

const form = (page: Page, name = 'Log harvest') => page.getByRole('dialog', { name });
const cards = (page: Page) => page.getByTestId('harvest-card');
const feedbackCard = (page: Page) => page.getByRole('region', { name: 'Quick question' });

async function openNewForm(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Log harvest' }).first().click();
  await expect(form(page)).toBeVisible();
}

async function choosePlant(page: Page): Promise<void> {
  await form(page).getByRole('combobox', { name: 'Plant' }).fill('Sugar');
  await form(page).getByRole('option', { name: new RegExp(PLANT) }).click();
}

test('empty state, and Save with no plant asks for one', async ({ page }) => {
  await page.goto('/harvest');
  await expect(page.getByText('Your first harvest is waiting. When you pick something, log it here.')).toBeVisible();
  await openNewForm(page);
  await form(page).getByRole('button', { name: 'Save harvest' }).click();
  await expect(form(page).getByText('Which plant did you harvest?')).toBeVisible();
  await expect(form(page).getByRole('combobox', { name: 'Plant' })).toBeFocused();
});

test('logging 340 g lists it under this month, and asks how it felt', async ({ page }) => {
  await page.goto('/harvest');
  await openNewForm(page);
  await choosePlant(page);
  await form(page).getByLabel('Quantity').fill('340');
  await form(page).getByRole('combobox', { name: 'Unit' }).selectOption('g');
  await form(page).getByRole('button', { name: 'Save harvest' }).click();
  await expect(form(page)).toHaveCount(0);

  const month = page.getByTestId('harvest-month').filter({ has: page.getByRole('heading', { name: currentMonthLabel() }) });
  await expect(month.getByTestId('harvest-card').filter({ hasText: PLANT })).toContainText('340 g');

  await expect(feedbackCard(page)).toContainText('How did logging your harvest feel?');
  await feedbackCard(page).getByRole('button', { name: 'Thumbs up' }).click();
  await expect(feedbackCard(page)).toContainText('Want to say more?');

  // The unit is remembered in localStorage, which each test's fresh browser
  // context starts without — so check it on this page.
  await openNewForm(page);
  await expect(form(page).getByRole('combobox', { name: 'Unit' })).toHaveValue('g');
});

test('a second harvest after reload shows no feedback card', async ({ page }) => {
  await page.goto('/harvest');
  await openNewForm(page);
  await choosePlant(page);
  await form(page).getByLabel('Notes').fill('Crisp pods');
  const shown = page.waitForResponse((r) => r.url().includes('/api/micro-feedback/shown'));
  await form(page).getByRole('button', { name: 'Save harvest' }).click();
  expect(await (await shown).json()).toEqual({ show: false });
  await expect(cards(page)).toHaveCount(2);
  await expect(feedbackCard(page)).toHaveCount(0);
});

test('edit the notes from the detail, then delete the entry', async ({ page }) => {
  await page.goto('/harvest');
  await cards(page).filter({ hasText: '340 g' }).click();
  await expect(page).toHaveURL(/\/harvest\/\d+/);

  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Edit' }).click();
  const edit = form(page, 'Edit harvest');
  await expect(edit.getByLabel('Notes')).toBeVisible();
  await edit.getByLabel('Notes').fill('Sweetest batch yet');
  await edit.getByRole('button', { name: 'Save harvest' }).click();
  await expect(edit).toHaveCount(0);
  await expect(page.getByTestId('harvest-notes')).toHaveText('Sweetest batch yet');

  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete harvest' });
  await expect(confirm).toContainText("Delete this harvest entry? This can't be undone.");
  await confirm.getByRole('button', { name: 'Delete' }).click();
  await expect(page).toHaveURL(/\/harvest$/);
  await expect(cards(page).filter({ hasText: '340 g' })).toHaveCount(0);
  await expect(cards(page)).toHaveCount(1);
});

test('searching notes adds a chip and filters; Clear all restores', async ({ page }) => {
  const created = await page.request.post('/api/harvests', {
    data: { gardenId: Number(gardenId), seedId, notes: 'Tough ends' },
  });
  expect(created.status()).toBe(201);

  await page.goto('/harvest');
  await expect(cards(page)).toHaveCount(2);
  await page.getByRole('searchbox', { name: 'Search' }).fill('crisp');
  await expect(page.getByRole('button', { name: 'Remove “crisp”' })).toBeVisible();
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page)).toContainText('Crisp pods');

  await page.getByRole('button', { name: 'Clear all' }).click();
  await expect(cards(page)).toHaveCount(2);
  await expect(page.getByRole('searchbox', { name: 'Search' })).toHaveValue('');
});

test('a ?log=new link with a seed shows the plant read-only', async ({ page }) => {
  await page.goto(`/harvest?log=new&gardenId=${gardenId}&seed=seed:${seedId}`);
  await expect(form(page).getByText(PLANT, { exact: true })).toBeVisible();
  await expect(form(page).getByRole('button', { name: 'Change' }).first()).toBeVisible();
  await expect(form(page).getByRole('combobox', { name: 'Plant' })).toHaveCount(0);
});

test('a free account sees the upgrade line instead of Add photo', async ({ page }) => {
  await page.goto('/harvest');
  await openNewForm(page);
  await expect(form(page).getByRole('button', { name: 'Add photo' })).toHaveCount(0);
  await expect(form(page)).toContainText('Upgrade to attach photos to your harvest entries.');
});

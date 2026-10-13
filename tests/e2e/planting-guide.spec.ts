import { test, expect, type Page } from '@playwright/test';
import { resetTestDb, createTestCambiumSeed, closePool } from './helpers/db';
import { addPlanting, createGuideFixture, signIn, currentSeason, type GuideFixture } from './helpers/guide';

const EMAIL = 'guide-desktop@example.com';
const PASSWORD = 'GuideDesk123!';

let fx: GuideFixture;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await resetTestDb();
  fx = await createGuideFixture(EMAIL, PASSWORD);
});
test.afterAll(closePool);

const viewButton = (page: Page, name: string) =>
  page.getByRole('group', { name: 'View' }).getByRole('button', { name });

const listItem = (page: Page, plant: string, item: string) =>
  page.getByTestId('guide-list-item').filter({ hasText: plant }).filter({ hasText: item });

test.describe('signed in', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, EMAIL, PASSWORD);
  });

  test('shows the calendar by default with both plants', async ({ page }) => {
    await page.goto('/guide');
    await expect(viewButton(page, 'Calendar')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: 'Open schedule for Tomato' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open schedule for Mystery Herb' })).toBeVisible();
    await expect(page.getByRole('img', { name: /^Start indoors, / })).toBeVisible();
    await expect(page.getByRole('img', { name: /^No dates yet, / })).toBeVisible();
  });

  test('list view shows the timed plant items and survives a reload', async ({ page }) => {
    await page.goto('/guide');
    await viewButton(page, 'List').click();
    await expect(listItem(page, 'Tomato', 'Start indoors')).toBeVisible();
    await expect(listItem(page, 'Tomato', 'Transplant out')).toBeVisible();

    await page.reload();
    await expect(viewButton(page, 'List')).toHaveAttribute('aria-pressed', 'true');
    await expect(listItem(page, 'Tomato', 'Start indoors')).toBeVisible();
  });

  test('the done checkbox stays ticked after a reload', async ({ page }) => {
    await page.goto('/guide');
    await viewButton(page, 'List').click();
    const checkbox = page.getByRole('checkbox', { name: 'Tomato: Start indoors done' });
    await expect(checkbox).not.toBeChecked();
    const saved = page.waitForResponse((r) => r.url().includes('/api/planting-guide/done') && r.ok());
    await checkbox.check();
    await saved;

    await page.reload();
    await expect(page.getByRole('checkbox', { name: 'Tomato: Start indoors done' })).toBeChecked();
    await expect(listItem(page, 'Tomato', 'Transplant out').getByText('Done', { exact: true })).toBeVisible();
  });

  test('a custom transplant date can be set and reset', async ({ page }) => {
    await page.goto('/guide');
    await page.getByRole('button', { name: 'Open schedule for Tomato' }).click();
    const dialog = page.getByRole('dialog', { name: 'Tomato schedule' });
    await expect(dialog).toBeVisible();

    const section = dialog.getByRole('region', { name: 'Transplant out' });
    await section.getByLabel('Your date').fill(`${fx.season}-05-10`);
    await expect(section.getByText('Custom date set')).toBeVisible();
    await expect(section.getByText('Your custom date')).toBeVisible();
    await expect(section.getByText('May 10', { exact: true })).toBeVisible();

    await section.getByRole('button', { name: 'Reset to recommended' }).click();
    await expect(section.getByText('Custom date set')).toHaveCount(0);
    await expect(section.getByText('Your custom date')).toHaveCount(0);
    await expect(section.getByText('Based on your frost dates')).toBeVisible();
  });

  test('the previous season is read-only', async ({ page }) => {
    await page.goto('/guide');
    await page.getByRole('group', { name: 'Season' }).getByRole('button', { name: String(fx.season - 1) }).click();
    await expect(page.getByText('Past seasons are read-only.')).toBeVisible();

    await page.getByRole('button', { name: 'Open schedule for Tomato' }).click();
    const dialog = page.getByRole('dialog', { name: 'Tomato schedule' });
    const inputs = dialog.getByLabel('Your date');
    await expect(inputs).toHaveCount(2);
    for (const input of await inputs.all()) await expect(input).toBeDisabled();
    await expect(dialog.getByText('Done for this season')).toHaveCount(0);
  });

  test('?open=seed:<id> opens that plant’s schedule', async ({ page }) => {
    await page.goto(`/guide?open=seed:${fx.timedSeedId}`);
    await expect(page.getByRole('dialog', { name: 'Tomato schedule' })).toBeVisible();
    await expect(page).not.toHaveURL(/open=/);
  });
});

test('a guest sees the sign-in prompt in the schedule', async ({ page }) => {
  const season = currentSeason();
  const cambiumSeedId = await createTestCambiumSeed(`Guide Guest Pea ${Date.now()}`);
  await page.goto('/login');
  expect((await page.request.post('/api/auth/guest')).ok()).toBe(true);
  const gardenResp = await page.request.post('/api/gardens', {
    data: { name: 'Guest Garden', style: 'grid', zone: '7b', growingMethod: 'in_ground' },
  });
  expect(gardenResp.status()).toBe(201);
  const garden = await gardenResp.json();
  await addPlanting(page.request, String(garden.id), season, { cambiumSeedId }, 0);

  await page.goto('/guide');
  await page.getByRole('button', { name: /^Open schedule for Guide Guest Pea/ }).click();
  const dialog = page.getByRole('dialog', { name: /Guide Guest Pea .* schedule/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('link', { name: 'Sign in to set your own dates' }).first()).toBeVisible();
});

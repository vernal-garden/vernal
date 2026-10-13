import { test, expect, type Page } from '@playwright/test';
import { resetTestDb, createTestUser, createTestGarden, closePool } from './helpers/db';

test.beforeAll(resetTestDb);
test.afterAll(closePool);

async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  // The user already has a garden, so login lands somewhere other than
  // /onboarding — just wait for it to leave /login.
  await expect(page).not.toHaveURL(/\/login/);
}

// The canvas bed-panel links (Soil history / Amendments) are checked by hand:
// canvas hit-testing makes bed selection impractical in E2E.
test('bed deep links and delete for soil readings and amendments', async ({ page }) => {
  const user = await createTestUser({
    email: 'soil-amend@example.com', password: 'SoilAmend123!', isSupporter: true,
  });
  const gardenId = await createTestGarden(user.id, 'Soil Garden');
  await signIn(page, user.email, user.password);

  const createBed = async (label: string, x: number): Promise<string> => {
    const resp = await page.request.post(`/api/gardens/${gardenId}/beds`, {
      data: { type: 'grid', label, grid: { x, y: 0, cols: 4, rows: 4 } },
    });
    expect(resp.status()).toBe(201);
    return (await resp.json()).id as string;
  };
  const bedA = await createBed('Bed Alpha', 0);
  const bedB = await createBed('Bed Beta', 10);

  const testDate = new Date().toISOString().slice(0, 10);
  const readingResp = await page.request.post(`/api/gardens/${gardenId}/soil-readings`, {
    data: { bedId: bedA, testDate, ph: 6.5 },
  });
  expect(readingResp.status()).toBe(201);

  const amendmentResp = await page.request.post(`/api/gardens/${gardenId}/amendments`, {
    data: {
      bedIds: [bedA], applicationDate: testDate,
      productName: 'Test Bone Meal', amendmentType: 'fertilizer_organic',
    },
  });
  expect(amendmentResp.status()).toBe(201);

  await test.step('?bed= opens the per-bed soil view', async () => {
    await page.goto(`/garden/${gardenId}/soil?bed=${bedA}`);
    await expect(page.getByRole('heading', { level: 2, name: 'Bed Alpha' })).toBeVisible();
    await expect(page.getByText(testDate)).toBeVisible();
  });

  await test.step('unknown ?bed= stays on the all-beds landing', async () => {
    await page.goto(`/garden/${gardenId}/soil?bed=999999`);
    await expect(page.getByText('Bed Alpha')).toBeVisible();
    await expect(page.getByText('Bed Beta')).toBeVisible();
    await expect(page.getByRole('button', { name: '← All beds' })).toHaveCount(0);
  });

  await test.step('delete a soil reading: cancel, then confirm', async () => {
    await page.goto(`/garden/${gardenId}/soil?bed=${bedA}`);
    await page.getByText(testDate).click();

    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete this reading?' });
    await expect(dialog).toContainText(`removes the ${testDate} reading for Bed Alpha`);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText(testDate)).toBeVisible();

    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await dialog.getByRole('button', { name: 'Delete reading' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('No readings yet.')).toBeVisible();
    await expect(page.getByText(testDate)).toHaveCount(0);

    const list = await (await page.request.get(`/api/gardens/${gardenId}/soil-readings`)).json();
    expect(list.data).toHaveLength(0);
  });

  await test.step('?bed= sets the amendment bed filter', async () => {
    await page.goto(`/garden/${gardenId}/amendments?bed=${bedB}`);
    await expect(page.locator('select').first()).toHaveValue(bedB);
    await expect(page.getByText('Test Bone Meal')).toHaveCount(0);
  });

  await test.step('delete an amendment', async () => {
    await page.locator('select').first().selectOption('all');
    await page.getByText('Test Bone Meal').click();

    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete this amendment?' });
    await expect(dialog).toContainText(`removes Test Bone Meal, applied ${testDate}`);
    await dialog.getByRole('button', { name: 'Delete amendment' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('Test Bone Meal')).toHaveCount(0);

    const list = await (await page.request.get(`/api/gardens/${gardenId}/amendments`)).json();
    expect(list.data).toHaveLength(0);
  });
});

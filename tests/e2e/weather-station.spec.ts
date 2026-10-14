import { test, expect, type Page } from '@playwright/test';
import { resetTestDb, createTestUser, closePool } from './helpers/db';
import { signIn } from './helpers/guide';

// A supporter with a saved location ('Test City') and no station can still
// connect one from the Weather page. Assertions stay on the station section so
// the tests never depend on the live forecast service answering.
const EMAIL = 'weather-station@example.com';
const PASSWORD = 'WeatherSt123!';

test.beforeAll(async () => {
  await resetTestDb();
  await createTestUser({ email: EMAIL, password: PASSWORD, isSupporter: true });
});
test.afterAll(closePool);

test.beforeEach(async ({ page }) => {
  await signIn(page, EMAIL, PASSWORD);
});

const stationSection = (page: Page) => page.getByRole('region', { name: 'Your weather station' });

test('the station section offers Connect a station, which opens the Tempest form', async ({ page }) => {
  await page.goto('/weather');
  const section = stationSection(page);
  await expect(section).toBeVisible();
  await expect(section).toContainText('Using the local weather service for Test City.');
  await expect(section.getByLabel('Personal access token')).toHaveCount(0);

  await section.getByRole('button', { name: 'Connect a station' }).click();
  await expect(section.getByLabel('Personal access token')).toBeVisible();
  await expect(section.getByText('Ambient Weather')).toBeVisible();
});

test('?connect=station opens the form without a click', async ({ page }) => {
  await page.goto('/weather?connect=station');
  const token = stationSection(page).getByLabel('Personal access token');
  await expect(token).toBeVisible();
  await expect(token).toBeFocused();
});

test('Cancel collapses the form back to the button', async ({ page }) => {
  await page.goto('/weather?connect=station');
  const section = stationSection(page);
  await expect(section.getByLabel('Personal access token')).toBeVisible();

  await section.getByRole('button', { name: 'Cancel' }).click();
  await expect(section.getByLabel('Personal access token')).toHaveCount(0);
  await expect(section.getByRole('button', { name: 'Connect a station' })).toBeVisible();
  await expect(page).toHaveURL(/\/weather$/);
});

import { test, expect, request } from '@playwright/test';
import {
  resetTestDb, createTestUser, createTestGarden, createTestSeed, setAccountRole,
  getModerationItemId, closePool,
} from './helpers/db';

test.beforeAll(resetTestDb);
test.afterAll(closePool);

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:4173';
const SEED_NAME = 'Notif Heirloom Tomato';
const ADMIN_NOTE = 'internal-only: photo is blurry';

test('rejected contribution notifies the contributor, without the admin note', async ({ page }) => {
  const user = await createTestUser({ email: 'notif-user@example.com', password: 'Notif123!' });
  await createTestGarden(user.id, 'Notif Garden');
  const seedId = await createTestSeed(user.id, SEED_NAME);
  const admin = await createTestUser({ email: 'notif-admin@example.com', password: 'Admin123!' });
  await setAccountRole(admin.id, 'admin');

  const userApi = await request.newContext({ baseURL: BASE_URL });
  const adminApi = await request.newContext({ baseURL: BASE_URL });
  try {
    expect((await userApi.post('/api/auth/login',
      { data: { email: user.email, password: user.password } })).ok()).toBe(true);
    const contribute = await userApi.post(`/api/seeds/${seedId}/contribute`, { data: {} });
    expect(contribute.status(), await contribute.text()).toBe(200);

    expect((await adminApi.post('/api/auth/login',
      { data: { email: admin.email, password: admin.password } })).ok()).toBe(true);
    const itemId = await getModerationItemId(seedId);
    const reject = await adminApi.patch(`/api/admin/moderation/${itemId}`,
      { data: { action: 'reject', note: ADMIN_NOTE } });
    expect(reject.status(), await reject.text()).toBe(200);
  } finally {
    await userApi.dispose();
    await adminApi.dispose();
  }

  await page.goto('/login');
  await page.fill('input[type="email"]', user.email);
  await page.fill('input[type="password"]', user.password);
  await page.click('button[type="submit"]');
  await expect(page).not.toHaveURL(/\/login/);
  await page.goto('/gardens');

  const bell = page.getByTestId('notification-bell');
  await expect(bell).toHaveAttribute('data-unread', '1');
  await expect(page.getByTestId('notification-dot')).toBeVisible();

  await bell.click();
  await expect(page.getByTestId('notification-panel')).toBeVisible();
  const row = page.getByTestId('notification-row');
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute('data-unread', 'true');
  await expect(row).toContainText(
    `Your submission of ${SEED_NAME} wasn't approved. You can edit it and try again.`);
  await expect(page.getByTestId('notification-panel')).not.toContainText(ADMIN_NOTE);

  await row.click();
  await expect(page).toHaveURL(/\/catalogue/);
  // The ?open=seed:<id> deep link opens that seed's overlay.
  await expect(page.getByRole('dialog').getByText(SEED_NAME).first()).toBeVisible();

  await expect(bell).toHaveAttribute('data-unread', '0');
  await expect(page.getByTestId('notification-dot')).toHaveCount(0);

  // Read state is persisted server-side, not just local.
  await page.reload();
  await expect(page.getByTestId('notification-bell')).toHaveAttribute('data-unread', '0');
});

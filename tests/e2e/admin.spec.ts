import { test, expect, type Page } from '@playwright/test';
import {
  resetTestDb, createTestUser, createTestGarden, createTestSeed, createTestCambiumSeed,
  setAccountRole, setSubscriptionTier, createModerationCorrection, createModerationNewSeed, createFeedback, closePool,
} from './helpers/db';

// Admin dashboard (desktop 'chromium' project). The mobile "better on desktop"
// notice is covered in mobile-shell.spec.ts.

const ADMIN = { email: 'admin-e2e-boss@example.com', password: 'AdminBoss123!' };
const REGULAR = { email: 'admin-e2e-gardener@example.com', password: 'Gardener123!' };
const MONTHLY_SUPPORTER = 'admin-e2e-monthly@example.com';
const LIFETIME_SUPPORTER = 'admin-e2e-lifetime@example.com';

// cambium.seeds is not cleared by resetTestDb, so the corrected seed gets a unique name.
const CORRECTED_SEED = `E2E Corrected Tomato ${Date.now()}`;
const SUBMITTED_SEED = 'E2E Submitted Squash';
const REJECT_NOTE = 'Duplicate of an existing Cambium entry.';
const FEEDBACK_BUG = 'The canvas freezes when I zoom out quickly.';
const FEEDBACK_IDEA = 'Please add a frost date reminder email.';

test.beforeAll(async () => {
  await resetTestDb();

  const admin = await createTestUser({ ...ADMIN, displayName: 'Admin Boss' });
  await setAccountRole(admin.id, 'admin');
  // A garden keeps '/' (where sign-in lands) from redirecting to /onboarding.
  await createTestGarden(admin.id, 'Admin Garden');

  // The regular account deliberately has no garden (the Users test expects
  // Gardens 0), so '/' sends it on to /onboarding.
  const regular = await createTestUser({ ...REGULAR, displayName: 'Regular Gardener' });

  const monthly = await createTestUser({ email: MONTHLY_SUPPORTER });
  await setSubscriptionTier(monthly.id, 'supporter', { interval: 'monthly', stripeSubscriptionId: 'sub_e2e_monthly' });
  const lifetime = await createTestUser({ email: LIFETIME_SUPPORTER });
  await setSubscriptionTier(lifetime.id, 'supporter', { interval: 'lifetime' });

  const cambiumSeedId = await createTestCambiumSeed(CORRECTED_SEED);
  await createModerationCorrection({
    cambiumSeedId,
    submittedBy: regular.id,
    correctionText: 'Days to maturity should be 75, not 55.',
    createdAt: '2 hours',
  });
  const seedId = await createTestSeed(regular.id, SUBMITTED_SEED);
  // Newer than the correction, so it is listed first in the All tab.
  await createModerationNewSeed({
    seedId,
    submittedBy: regular.id,
    content: { commonName: SUBMITTED_SEED, scientificName: 'Cucurbita pepo', notes: 'Grows well in raised beds.' },
    createdAt: '1 hour',
  });

  await createFeedback({
    userId: regular.id, category: 'bug', message: FEEDBACK_BUG,
    sourceSurface: 'canvas', appVersion: '1.0.0', createdAt: '30 minutes',
  });
  await createFeedback({
    category: 'feature_request', message: FEEDBACK_IDEA,
    sourceSurface: 'settings', appVersion: '1.0.0', createdAt: '3 hours',
  });
});
test.afterAll(closePool);

async function signIn(page: Page, user: { email: string; password: string }): Promise<void> {
  await page.goto('/login');
  await page.fill('input[type="email"]', user.email);
  await page.fill('input[type="password"]', user.password);
  await page.click('button[type="submit"]');
  await expect(page).not.toHaveURL(/\/login/);
}

test('a regular account is sent away from the admin dashboard', async ({ page }) => {
  await signIn(page, REGULAR);
  await page.goto('/admin/seeds');
  // AdminRoute redirects non-admins to '/', which then sends this garden-less
  // account on to /onboarding.
  await expect(page).toHaveURL('/onboarding');
  await expect(page.getByRole('navigation', { name: 'Admin' })).toHaveCount(0);
});

test.describe('signed in as admin', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, ADMIN);
  });

  test('sidebar sections and the Seed DB page', async ({ page }) => {
    await page.goto('/admin');
    await expect(page).toHaveURL('/admin/seeds');

    const nav = page.getByRole('navigation', { name: 'Admin' });
    for (const label of ['Seed DB', 'Moderation', 'Users', 'Features', 'Feedback', 'System']) {
      await expect(nav.getByRole('link', { name: label, exact: true })).toBeVisible();
    }
    await expect(page.getByRole('heading', { level: 1, name: 'Seed DB' })).toBeVisible();

    const main = page.getByRole('main');
    for (const label of ['Total seeds', 'Community seeds', 'Pending moderation', 'Added this month']) {
      await expect(main.getByText(label, { exact: true })).toBeVisible();
    }
    await expect(main.getByRole('table').getByRole('columnheader', { name: 'Family' })).toBeVisible();
  });

  test('moderation: reject a new seed, then find it under Resolved', async ({ page }) => {
    await page.goto('/admin/moderation');
    const tabs = page.getByRole('tablist', { name: 'Moderation queue' });
    const panel = page.getByRole('tabpanel');

    await tabs.getByRole('tab', { name: /^New seeds/ }).click();
    await expect(page).toHaveURL(/tab=new_seeds/);
    await expect(panel.getByRole('button', { name: new RegExp(SUBMITTED_SEED) })).toBeVisible();
    await expect(panel.getByRole('button', { name: new RegExp(CORRECTED_SEED) })).toHaveCount(0);

    // Reject from All, where the correction is still queued below it.
    await tabs.getByRole('tab', { name: /^All/ }).click();
    const rows = panel.getByRole('button');
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText(SUBMITTED_SEED);
    await rows.first().click();
    await expect(page.getByRole('heading', { level: 2, name: 'New seed submission' })).toBeVisible();

    await page.getByRole('button', { name: 'Reject', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Reject this submission?' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Reason for rejection (optional, not shown to user)').fill(REJECT_NOTE);
    await dialog.getByRole('button', { name: 'Confirm' }).click();
    await expect(dialog).toBeHidden();

    // The detail panel moves on to the next unresolved item: the correction.
    await expect(page.getByRole('heading', { level: 2, name: 'Seed correction' })).toBeVisible();
    await expect(page.getByRole('main').getByRole('link', { name: CORRECTED_SEED })).toBeVisible();
    await expect(panel.getByRole('button', { name: new RegExp(SUBMITTED_SEED) })).toHaveCount(0);

    await tabs.getByRole('tab', { name: /^Resolved/ }).click();
    const resolvedRow = panel.getByRole('button', { name: new RegExp(SUBMITTED_SEED) });
    await expect(resolvedRow).toBeVisible();
    await expect(resolvedRow.getByRole('img', { name: 'Rejected' })).toBeVisible();
    await resolvedRow.click();

    await expect(page.getByRole('heading', { level: 2, name: 'New seed submission' })).toBeVisible();
    const resolution = page.locator('section', { has: page.getByRole('heading', { name: 'Resolution' }) });
    await expect(resolution).toContainText('Rejected');
    await expect(resolution).toContainText(REJECT_NOTE);
    await expect(page.getByRole('button', { name: 'Reject', exact: true })).toHaveCount(0);
  });

  test('feedback: archive with E, find it under Everything, then restore', async ({ page }) => {
    await page.goto('/admin/feedback');
    const list = page.getByRole('list', { name: 'Feedback' });
    const bugRow = list.getByRole('button', { name: new RegExp(FEEDBACK_BUG) });
    await expect(bugRow).toBeVisible();
    await expect(list.getByRole('button', { name: new RegExp(FEEDBACK_IDEA) })).toBeVisible();
    await bugRow.click();

    const detail = page.locator('[aria-label="Feedback detail"]');
    const status = detail.getByTestId('feedback-status');
    await expect(detail.getByRole('heading', { name: /^Feedback #\d+$/ })).toBeVisible();
    await expect(status).toHaveText('New');

    await detail.focus();
    await page.keyboard.press('e');
    await expect(status).toHaveText('Archived');
    // Archived items drop out of the default Active list.
    await expect(bugRow).toHaveCount(0);
    await expect(list.getByRole('button', { name: new RegExp(FEEDBACK_IDEA) })).toBeVisible();

    // The <label> wraps the <select>, so its accessible name also carries the option text.
    await page.getByRole('combobox', { name: /^Status/ }).selectOption('everything');
    await expect(page).toHaveURL(/status=everything/);
    await expect(bugRow).toBeVisible();
    await expect(bugRow.getByRole('img', { name: 'Archived' })).toBeVisible();

    await detail.getByRole('button', { name: 'Restore' }).click();
    await expect(status).toHaveText('Read');
    await expect(bugRow.getByRole('img', { name: 'Read' })).toBeVisible();
  });

  test('users: comp a supporter and open the account details', async ({ page }) => {
    await page.goto('/admin/users');
    await page.getByLabel('Search by email').fill(REGULAR.email);

    const row = page.getByRole('row', { name: new RegExp(REGULAR.email) });
    await expect(row).toBeVisible();
    await expect(page.getByRole('row', { name: new RegExp(ADMIN.email) })).toHaveCount(0);
    await expect(row.getByRole('cell', { name: 'free', exact: true })).toBeVisible();

    await row.getByRole('button', { name: 'Comp as Supporter' }).click();
    const dialog = page.getByRole('dialog', { name: `Comp ${REGULAR.email} as Supporter?` });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Comp as Supporter' }).click();
    await expect(dialog).toBeHidden();
    await expect(row.getByRole('cell', { name: 'supporter', exact: true })).toBeVisible();

    await row.getByRole('cell', { name: REGULAR.email, exact: true }).click();
    const details = page.getByRole('complementary', { name: 'Account details' });
    await expect(details).toBeVisible();
    await expect(details.getByRole('heading', { name: REGULAR.email })).toBeVisible();
    const field = (label: string) => details.locator(`dt:text-is("${label}") + dd`);
    await expect(field('Gardens')).toHaveText('0');
    await expect(field('Stripe subscription')).toHaveText('None');
    await expect(field('Tier')).toHaveText('supporter');
  });

  test('users: a paid subscriber cannot be set to free', async ({ page }) => {
    await page.goto('/admin/users');
    await page.getByLabel('Search by email').fill(MONTHLY_SUPPORTER);

    const row = page.getByRole('row', { name: new RegExp(MONTHLY_SUPPORTER) });
    await expect(row).toBeVisible();
    await expect(row.getByRole('button', { name: 'Set to free' })).toHaveCount(0);
    await expect(row.getByText('Paid via Stripe')).toBeVisible();

    await row.getByRole('cell', { name: MONTHLY_SUPPORTER, exact: true }).click();
    const details = page.getByRole('complementary', { name: 'Account details' });
    await expect(details.getByRole('heading', { name: MONTHLY_SUPPORTER })).toBeVisible();
    await expect(details.getByRole('button', { name: 'Set to free' })).toHaveCount(0);
    await expect(details.getByText('Paid subscription. Cancel it in Stripe to downgrade.')).toBeVisible();
  });

  test('users: a lifetime supporter can still be set to free', async ({ page }) => {
    await page.goto('/admin/users');
    await page.getByLabel('Search by email').fill(LIFETIME_SUPPORTER);

    const row = page.getByRole('row', { name: new RegExp(LIFETIME_SUPPORTER) });
    await expect(row).toBeVisible();
    await expect(row.getByRole('button', { name: 'Set to free' })).toBeVisible();
    await expect(row.getByText('Paid via Stripe')).toHaveCount(0);
  });

  test('system: status banner and the nightly job', async ({ page }) => {
    await page.goto('/admin/system');
    const main = page.getByRole('main');
    await expect(main.getByRole('status')).toHaveText(/^(All systems operational|Degraded performance|Outage)$/);
    await expect(main.getByRole('heading', { level: 2, name: 'Jobs' })).toBeVisible();
    await expect(main.getByRole('row', { name: /Nightly maintenance/ })).toBeVisible();
  });
});

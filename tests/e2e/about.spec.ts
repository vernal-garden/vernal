import { test, expect, type Page } from '@playwright/test';
import { resetTestDb, createTestUser, getFeedbackByMessage, closePool } from './helpers/db';

test.beforeAll(resetTestDb);
test.afterAll(closePool);

test('about page shows the version and the external links', async ({ page }) => {
  const user = await createTestUser({ email: 'about-user@example.com', password: 'About123!' });
  await page.goto('/login');
  await page.fill('input[type="email"]', user.email);
  await page.fill('input[type="password"]', user.password);
  await page.click('button[type="submit"]');
  await expect(page).not.toHaveURL(/\/login/);

  await page.goto('/about');
  await expect(page.getByTestId('about-page')).toBeVisible();
  await expect(page.getByTestId('about-version')).toHaveText(/^Version \S+/);
  await expect(page.getByTestId('about-version')).not.toContainText('undefined');

  const links = {
    'about-license-link': 'https://github.com/vernal-garden/vernal/blob/main/LICENSE',
    'about-source-link': 'https://github.com/vernal-garden/vernal',
    'about-issues-link': 'https://github.com/vernal-garden/vernal/issues',
  };
  for (const [testId, href] of Object.entries(links)) {
    const link = page.getByTestId(testId);
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', href);
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /noopener/);
    await expect(link).toHaveAttribute('rel', /noreferrer/);
  }

  const credit = page.getByTestId('weather-credit');
  await expect(credit).toBeVisible();
  const creditLinks = [
    'https://www.visualcrossing.com/',
    'https://www.openstreetmap.org/copyright',
  ];
  for (const href of creditLinks) {
    const link = credit.locator(`a[href="${href}"]`);
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /noopener/);
    await expect(link).toHaveAttribute('rel', /noreferrer/);
  }
});

async function signInAboutUser(page: Page): Promise<void> {
  await page.goto('/login');
  await page.fill('input[type="email"]', 'about-user@example.com');
  await page.fill('input[type="password"]', 'About123!');
  await page.click('button[type="submit"]');
  await expect(page).not.toHaveURL(/\/login/);
}

test('about feedback button opens the feedback panel and Escape returns focus', async ({ page }) => {
  // The account is created by the first test; tests in this file run serially.
  await signInAboutUser(page);
  await page.goto('/about');

  const button = page.getByTestId('about-feedback-button');
  await button.click();
  const dialog = page.getByRole('dialog', { name: 'Send feedback' });
  await expect(dialog).toBeVisible();
  await expect.poll(() => dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(button).toBeFocused();
});

test('a guest can send feedback from the about page', async ({ page }) => {
  await page.goto('/onboarding');
  // The client mints the guest session asynchronously after first load.
  await expect.poll(async () => (await page.context().cookies())
    .some((c) => c.name === '_vernal_sid')).toBe(true);

  await page.goto('/about');
  await page.getByTestId('about-feedback-button').click();
  const dialog = page.getByRole('dialog', { name: 'Send feedback' });
  await expect(dialog).toBeVisible();

  const message = `About page guest bug ${Date.now()}`;
  await dialog.getByRole('radio', { name: /Bug/ }).click();
  await dialog.getByLabel('Feedback message').fill(message);
  await dialog.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(dialog.getByRole('status')).toHaveText('Got it — thanks.');

  await expect.poll(() => getFeedbackByMessage(message)).not.toBeNull();
  const row = await getFeedbackByMessage(message);
  expect(row).toEqual({ user_id: null, category: 'bug', source_surface: 'about' });
});

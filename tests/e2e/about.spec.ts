import { test, expect } from '@playwright/test';
import { resetTestDb, createTestUser, closePool } from './helpers/db';

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
});

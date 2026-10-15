import { test, expect, type Locator, type Page } from '@playwright/test';
import { resetTestDb, createTestUser, createTestGarden, setAccountRole, closePool } from './helpers/db';

// Runs only in the 'mobile' (Pixel 7) project — see playwright.config.ts.

const EMAIL = 'mobile-shell@example.com';
const PASSWORD = 'MobileShell123!';
const ADMIN_EMAIL = 'mobile-admin@example.com';
const ADMIN_PASSWORD = 'MobileAdmin123!';

const TAB_ROUTES = [
  { label: 'Gardens', url: '/gardens', title: 'My Gardens' },
  { label: 'Canvas', url: '/', title: 'Garden' },
  { label: 'Planting', url: '/guide', title: 'Planting Guide' },
  { label: 'Catalogue', url: '/catalogue', title: 'Seed Catalogue' },
  { label: 'Harvest', url: '/harvest', title: 'Harvest' },
];

let gardenId: string;

test.beforeAll(async () => {
  await resetTestDb();
  const user = await createTestUser({ email: EMAIL, password: PASSWORD, isSupporter: true });
  // A garden keeps '/' from redirecting to /onboarding.
  gardenId = await createTestGarden(user.id, 'Mobile Garden');
  const admin = await createTestUser({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  await setAccountRole(admin.id, 'admin');
  await createTestGarden(admin.id, 'Admin Garden');
});
test.afterAll(closePool);

async function signIn(page: Page, email = EMAIL, password = PASSWORD): Promise<void> {
  await page.goto('/login');
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await expect(page).not.toHaveURL(/\/login/);
}

const tabBar = (page: Page) => page.getByRole('navigation', { name: 'Primary' });
const topBar = (page: Page) => page.getByRole('banner');

async function expectTouchTargets(region: Locator): Promise<void> {
  const targets = region.locator('a, button');
  const count = await targets.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) {
    const box = await targets.nth(i).boundingBox();
    const name = await targets.nth(i).evaluate((el) => el.getAttribute('aria-label') ?? el.textContent);
    expect(box, `${name} has no bounding box`).not.toBeNull();
    expect(box!.width, `${name} width`).toBeGreaterThanOrEqual(44);
    expect(box!.height, `${name} height`).toBeGreaterThanOrEqual(44);
  }
}

test.describe('signed in', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('tab bar replaces the desktop nav', async ({ page }) => {
    await page.goto('/gardens');
    const nav = tabBar(page);
    await expect(nav).toBeVisible();
    for (const { label } of TAB_ROUTES) {
      await expect(nav.getByRole('link', { name: label })).toBeVisible();
    }
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeHidden();
    await expect(nav.getByRole('link', { name: 'Weather' })).toHaveCount(0);
  });

  test('weather is reachable from the Harvest page', async ({ page }) => {
    await page.goto('/harvest');
    await page.getByRole('main').getByRole('link', { name: 'Weather' }).tap();
    await expect(page).toHaveURL('/weather');
    await expect(topBar(page).getByText('Weather', { exact: true })).toBeVisible();
  });

  test('each tab navigates and marks itself current', async ({ page }) => {
    await page.goto('/gardens');
    for (const { label, url } of TAB_ROUTES) {
      const tab = tabBar(page).getByRole('link', { name: label });
      await tab.tap();
      await expect(page).toHaveURL(url);
      await expect(tab).toHaveAttribute('aria-current', 'page');
    }
  });

  test('top bar shows the route title and the account link', async ({ page }) => {
    for (const { url, title } of TAB_ROUTES) {
      await page.goto(url);
      await expect(topBar(page).getByText(title, { exact: true })).toBeVisible();
      await expect(topBar(page).getByRole('link', { name: 'Account', exact: true })).toBeVisible();
    }
    await expect(topBar(page).getByRole('link', { name: 'Account', exact: true })).toHaveText('M');
  });

  test('no horizontal overflow on shell pages', async ({ page }) => {
    for (const url of ['/gardens', '/catalogue', '/guide', '/harvest', '/weather', '/account']) {
      await page.goto(url);
      await expect(tabBar(page)).toBeVisible();
      // Let async page content settle before measuring.
      await page.waitForLoadState('networkidle');
      const { scrollWidth, innerWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }));
      expect(scrollWidth, `${url} overflows horizontally`).toBeLessThanOrEqual(innerWidth);
    }
  });

  test('tab bar and top bar targets are at least 44x44', async ({ page }) => {
    await page.goto('/gardens');
    await expect(tabBar(page)).toBeVisible();
    await expectTouchTargets(tabBar(page));
    await expectTouchTargets(topBar(page));

    // Detail routes add the back button.
    await page.goto(`/garden/${gardenId}/soil`);
    await expect(topBar(page).getByRole('button', { name: 'Back' })).toBeVisible();
    await expectTouchTargets(topBar(page));
  });

  test('top bar shows the notification bell and every control stays 44x44', async ({ page }) => {
    await page.goto('/gardens');
    const bell = topBar(page).getByTestId('notification-bell');
    await expect(bell).toBeVisible();
    await expectTouchTargets(topBar(page));
    const box = await bell.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
  });

  test('canvas toolbar sits above the tab bar',async ({ page }) => {
    await page.goto('/');
    const zoomIn = page.getByRole('button', { name: 'Zoom in' });
    await expect(zoomIn).toBeVisible();
    // The toolbar has no role of its own; measure its fixed-position container.
    const toolbarBottom = await zoomIn.evaluate((el) => {
      let node: HTMLElement | null = el;
      while (node && getComputedStyle(node).position !== 'fixed') node = node.parentElement;
      if (!node) throw new Error('No fixed-position toolbar container found');
      return node.getBoundingClientRect().bottom;
    });
    const tabBarBox = await tabBar(page).boundingBox();
    expect(tabBarBox).not.toBeNull();
    expect(toolbarBottom).toBeLessThanOrEqual(tabBarBox!.y);
  });
});

test('admin dashboard shows the desktop-only notice on a phone', async ({ page }) => {
  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  await page.goto('/admin/seeds');
  await expect(page).toHaveURL('/admin/seeds');
  await expect(page.getByText('The admin dashboard is desktop-only.', { exact: false })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Admin' })).toHaveCount(0);
});

test('guest sees Sign in instead of the account link', async ({ page }) => {
  await page.goto('/gardens');
  await expect(tabBar(page)).toBeVisible();
  await expect(topBar(page).getByText('My Gardens', { exact: true })).toBeVisible();
  await expect(topBar(page).getByRole('link', { name: 'Sign in' })).toBeVisible();
  await expect(topBar(page).getByRole('link', { name: 'Account', exact: true })).toHaveCount(0);
});

test.describe('guest About link', () => {
  test('top bar shows About, which goes to /about, and every control stays 44x44', async ({ page }) => {
    await page.goto('/gardens');
    const about = topBar(page).getByRole('link', { name: 'About', exact: true });
    await expect(about).toBeVisible();
    await expectTouchTargets(topBar(page));

    await about.tap();
    await expect(page).toHaveURL('/about');
    await expect(about).toHaveAttribute('aria-current', 'page');
    await expect(topBar(page).getByText('About', { exact: true }).first()).toBeVisible();
    await expectTouchTargets(topBar(page));
  });

  test('at 360px the route title is not clipped', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    for (const { url, title } of [...TAB_ROUTES.filter(({ url }) => url !== '/'), { url: '/about', title: 'About' }]) {
      await page.goto(url);
      const heading = topBar(page).getByText(title, { exact: true }).first();
      await expect(heading).toBeVisible();
      const { scrollWidth, clientWidth } = await heading.evaluate((el) => ({
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      }));
      expect(scrollWidth, `"${title}" is clipped`).toBeLessThanOrEqual(clientWidth);
    }
  });
});

import { test, expect, type Page } from '@playwright/test';
import { resetTestDb, createTestUser, createTestGarden, closePool } from './helpers/db';
import { WHATS_NEW } from '../../client/src/content/whatsNew';

// page.route can't see requests a service worker handles, and announceNewest()
// below rewrites the app's scripts.
test.use({ serviceWorkers: 'block' });

const EMAIL = 'whats-new@example.com';
const PASSWORD = 'WhatsNew123!';
const KEY = 'vernal.whatsNew.lastSeen';
const OLD_ID = '2000-01-01-old';
// Subpixel layout can put a 44px box at 43.6 or so.
const TOLERANCE = 0.5;

const newest = WHATS_NEW[0];

test.beforeAll(async () => {
  await resetTestDb();
  const user = await createTestUser({ email: EMAIL, password: PASSWORD });
  // '/' sends an account without a garden to onboarding, where the card is hidden.
  await createTestGarden(user.id);
});
// A late chunk request may still be in flight when a test ends.
test.afterEach(({ page }) => page.unrouteAll({ behavior: 'ignoreErrors' }));
test.afterAll(closePool);

const card = (page: Page) => page.getByTestId('whats-new-card');
const storedId = (page: Page) => page.evaluate((key) => window.localStorage.getItem(key), KEY);

async function signIn(page: Page): Promise<void> {
  const res = await page.request.post('/api/auth/login', { data: { email: EMAIL, password: PASSWORD } });
  expect(res.ok(), await res.text()).toBe(true);
}

// Runs on every load, so it only fills an empty slot: what the app stores survives a reload.
async function seedLastSeen(page: Page, id = OLD_ID): Promise<void> {
  await page.addInitScript(([key, value]) => {
    if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, value);
  }, [KEY, id] as const);
}

type Load = (go: () => Promise<unknown>) => Promise<void>;

// Turns the newest entry's `announce` on in the served bundle, for a build
// whose newest entry is history only. One that is already announced is left as is.
//
// Returns a wrapper every full page load must go through. It fails unless that
// load served the entry announced, so "no card" can't pass on a missed rewrite.
async function announceNewest(page: Page): Promise<Load> {
  const literal = new RegExp(`\\bid:\\s*["'\`]${newest.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'\`]`);
  let found = false;
  let announced = false;

  await page.route('**/assets/*.js', async (route) => {
    const response = await route.fetch();
    let body = await response.text();
    const entry = literal.exec(body);
    if (entry) {
      found = true;
      const start = entry.index + entry[0].length;
      const rest = body.slice(start);
      // Stops at the next entry's id, so the flip can't land on an older one.
      const nextId = rest.search(/\bid:\s*["'`]\d{4}-\d{2}-\d{2}-/);
      const own = nextId === -1 ? rest : rest.slice(0, nextId);
      const flipped = own.replace(/\bannounce:\s*(?:!0|!1|true|false)/, 'announce:!0');
      announced = flipped.includes('announce:!0');
      body = body.slice(0, start) + flipped + rest.slice(own.length);
    }
    // The fetched body is decoded, and may have changed length.
    const headers = response.headers();
    delete headers['content-encoding'];
    delete headers['content-length'];
    await route.fulfill({ response, headers, body });
  });

  return async (go) => {
    found = false;
    announced = false;
    await go();
    expect(found, `announceNewest: no script served by this load contained the entry ${newest.id}`).toBe(true);
    expect(announced, `announceNewest: found ${newest.id} but could not turn its announce flag on`).toBe(true);
  };
}

test('a fresh browser sees no card and starts caught up', async ({ page }) => {
  await signIn(page);
  const load = await announceNewest(page);
  await load(() => page.goto('/gardens'));

  // Written as the card mounts, so the count below isn't just early.
  await expect.poll(() => storedId(page)).toBe(newest.id);
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  await expect(card(page)).toHaveCount(0);

  await load(() => page.reload());
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  await expect(card(page)).toHaveCount(0);
});

test('the newest announced entry shows as a status below the nav without taking focus', async ({ page }) => {
  await signIn(page);
  await seedLastSeen(page);
  const load = await announceNewest(page);
  await load(() => page.goto('/gardens'));

  await expect(card(page)).toBeVisible();
  await expect(card(page)).toHaveAttribute('role', 'status');
  await expect(card(page)).toHaveAttribute('aria-live', 'polite');
  await expect(card(page).getByRole('heading', { name: "What's new in Vernal" })).toBeVisible();
  await expect(card(page).getByText(newest.title, { exact: true })).toBeVisible();
  await expect(card(page).getByRole('listitem')).toHaveText(newest.items);

  expect(await card(page).evaluate((el) => el.contains(document.activeElement))).toBe(false);

  const nav = (await page.getByRole('navigation', { name: 'Main navigation' }).boundingBox())!;
  const box = (await card(page).boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(nav.y + nav.height);
  // Showing it isn't seeing it.
  expect(await storedId(page)).toBe(OLD_ID);
});

test('Dismiss hides the card for good', async ({ page }) => {
  await signIn(page);
  await seedLastSeen(page);
  const load = await announceNewest(page);
  await load(() => page.goto('/gardens'));

  await card(page).getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(card(page)).toHaveCount(0);
  expect(await storedId(page)).toBe(newest.id);

  await load(() => page.reload());
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  await expect(card(page)).toHaveCount(0);
  expect(await storedId(page)).toBe(newest.id);
});

test('"See all" opens the history on the About page and counts as seen', async ({ page }) => {
  // Short enough that the history is off screen until the page scrolls to it.
  await page.setViewportSize({ width: 1280, height: 420 });
  await signIn(page);
  await seedLastSeen(page);
  const load = await announceNewest(page);
  await load(() => page.goto('/gardens'));

  await card(page).getByRole('button', { name: 'See all', exact: true }).click();
  await expect(page).toHaveURL('/about#whats-new');
  const history = page.getByRole('region', { name: "What's new", exact: true });
  await expect(history.getByRole('heading', { name: "What's new", exact: true })).toBeInViewport({ ratio: 1 });
  await expect(history.getByRole('heading', { name: newest.title, exact: true })).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await expect(card(page)).toHaveCount(0);

  await load(() => page.reload());
  await expect(page.getByTestId('about-page')).toBeVisible();
  await expect(card(page)).toHaveCount(0);
  expect(await storedId(page)).toBe(newest.id);
});

test('opening the About page directly scrolls to the history and does not count as seen', async ({ page }) => {
  // Short enough that the history is off screen until the page scrolls to it.
  await page.setViewportSize({ width: 1280, height: 420 });
  await signIn(page);
  await seedLastSeen(page);
  const load = await announceNewest(page);
  await load(() => page.goto('/about#whats-new'));

  const history = page.getByRole('region', { name: "What's new", exact: true });
  await expect(history.getByRole('heading', { name: "What's new", exact: true })).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  // Still offered: the card only goes away through its own buttons.
  await expect(card(page)).toBeVisible();
  expect(await storedId(page)).toBe(OLD_ID);
});

test('the card waits until the reader leaves the login page', async ({ page }) => {
  await seedLastSeen(page);
  const load = await announceNewest(page);
  await load(() => page.goto('/login'));

  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await expect(card(page)).toHaveCount(0);
  expect(await storedId(page)).toBe(OLD_ID);

  await page.click('button[type="submit"]');
  await expect(page).toHaveURL('/');
  await expect(card(page)).toBeVisible();
  expect(await storedId(page)).toBe(OLD_ID);
});

test('on a phone the card fits between the bars and its buttons are 44px', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await seedLastSeen(page);
  const load = await announceNewest(page);
  await load(() => page.goto('/gardens'));
  await expect(card(page)).toBeVisible();

  const box = (await card(page).boundingBox())!;
  // --sp-4 either side.
  expect(box.x).toBeGreaterThanOrEqual(16 - TOLERANCE);
  expect(box.x + box.width).toBeLessThanOrEqual(390 - 16 + TOLERANCE);
  const topBar = (await page.getByRole('banner').boundingBox())!;
  const tabBar = (await page.getByRole('navigation', { name: 'Primary' }).boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(topBar.y + topBar.height);
  expect(box.y + box.height).toBeLessThanOrEqual(tabBar.y);

  for (const name of ['Dismiss', 'See all']) {
    const button = (await card(page).getByRole('button', { name, exact: true }).boundingBox())!;
    expect(button.width, `${name} width`).toBeGreaterThanOrEqual(44 - TOLERANCE);
    expect(button.height, `${name} height`).toBeGreaterThanOrEqual(44 - TOLERANCE);
  }
});

test('an entry that is not announced shows no card', async ({ page }) => {
  test.skip(newest.announce, 'the newest entry is announced');
  await signIn(page);
  // Only the newest entry is unseen, so an older announced one can't show the card.
  const previous = WHATS_NEW[1]?.id ?? OLD_ID;
  await seedLastSeen(page, previous);
  await page.goto('/gardens');

  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  await expect(card(page)).toHaveCount(0);
  expect(await storedId(page)).toBe(previous);
});

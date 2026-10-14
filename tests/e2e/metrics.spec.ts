import { test, expect, type Page } from '@playwright/test';
import { resetTestDb, closePool, setSubscriptionTier } from './helpers/db';
import { signIn } from './helpers/guide';
import { createMetricsFixture, shortDate, type MetricsFixture } from './helpers/metrics';

// Desktop Metrics Dashboard and Cross-Season Comparison (Phase 49). The tests
// share one account (free, then a supporter from test 4 on), so they run in order.
test.describe.configure({ mode: 'serial' });

const EMAIL = 'metrics-desktop@example.com';
const PASSWORD = 'MetricsDesk123!';
const PLANT = 'Cherokee Tomato';

let fx: MetricsFixture;

test.beforeAll(async () => {
  await resetTestDb();
  fx = await createMetricsFixture(EMAIL, PASSWORD, PLANT);
});
test.afterAll(closePool);

test.beforeEach(async ({ page }) => {
  await signIn(page, EMAIL, PASSWORD);
});

const totalsCard = (page: Page) => page.getByRole('region', { name: 'Harvest totals' });
const trendCard = (page: Page) => page.getByRole('region', { name: 'Year over year' });
const upgradeLinks = (page: Page) => page.getByRole('link', { name: 'Learn more & upgrade' });

test('a free account sees the summary, totals, trend, and four upgrade cards', async ({ page }) => {
  await page.goto('/data');
  await expect(page.getByRole('heading', { level: 1, name: 'Data' })).toBeVisible();
  await expect(
    page.getByText(`2 harvests · first ${shortDate(fx.firstDate)} · latest ${shortDate(fx.latestDate)}`, { exact: true }),
  ).toBeVisible();

  const row = totalsCard(page).getByRole('link', { name: new RegExp(PLANT) });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('500 g');

  await expect(trendCard(page)).toContainText(`compared with ${fx.lastYear}`);
  await expect(trendCard(page).getByRole('listitem').filter({ hasText: PLANT })).toContainText('Up 25%');

  await expect(upgradeLinks(page)).toHaveCount(4);
  for (const name of ['Soil chemistry tracking', 'Fertilizer & amendment log', 'Weather station integration', 'Advanced analytics']) {
    await expect(page.getByRole('region', { name, exact: true }).getByRole('link', { name: 'Learn more & upgrade' })).toBeVisible();
  }
});

test('the totals row opens the harvest log filtered to that plant and season', async ({ page }) => {
  await page.goto('/data');
  await totalsCard(page).getByRole('link', { name: new RegExp(PLANT) }).click();
  await expect(page).toHaveURL(
    new RegExp(`/harvest\\?seed=seed(%3A|:)${fx.seedId}&season=${fx.thisYear}$`),
  );
  const cards = page.getByTestId('harvest-card');
  await expect(cards).toHaveCount(2);
  await expect(cards.filter({ hasText: '340 g' })).toHaveCount(1);
  await expect(cards.filter({ hasText: '160 g' })).toHaveCount(1);
  await expect(cards.filter({ hasText: '400 g' })).toHaveCount(0);
});

test('View full comparison shows the upgrade prompt to a free account', async ({ page }) => {
  await page.goto('/data');
  await trendCard(page).getByRole('link', { name: 'View full comparison' }).click();
  await expect(page).toHaveURL(/\/data\/compare$/);
  await expect(page.getByRole('heading', { name: 'Cross-season comparison' })).toBeVisible();
  await expect(page.getByText('See how a plant did across seasons, side by side.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Learn more & upgrade' })).toBeVisible();
});

test('a supporter sees the paid cards and compares two seasons as chart and table', async ({ page }) => {
  await setSubscriptionTier(fx.accountId, 'supporter');

  // An amendment dated this season (the first harvest date is never in the future).
  const amendmentResp = await page.request.post(`/api/gardens/${fx.gardenId}/amendments`, {
    data: {
      bedIds: [String(fx.bedId)], applicationDate: fx.firstDate,
      productName: 'Test Bone Meal', amendmentType: 'fertilizer_organic',
    },
  });
  expect(amendmentResp.status(), await amendmentResp.text()).toBe(201);

  await page.goto('/data');
  const advanced = page.getByRole('region', { name: 'Advanced analytics' });
  await expect(advanced).toBeVisible();
  await expect(upgradeLinks(page)).toHaveCount(0);
  // 500 g over the 4 x 8 bed's 32 sq ft.
  await expect(advanced.getByText('Yield per square foot')).toBeVisible();
  await expect(advanced).toContainText('15.63 g per sq ft');

  await expect(page.getByRole('region', { name: 'Amendments', exact: true }))
    .toContainText(`Last applied ${shortDate(fx.firstDate)}: Test Bone Meal`);
  // The test account has no location, so the Weather card prompts for one
  // instead of calling the forecast service.
  await expect(page.getByRole('region', { name: 'Weather', exact: true }))
    .toContainText('Set your location to see local weather.');
  await expect(
    page.getByRole('region', { name: 'Weather', exact: true }).getByRole('link', { name: 'Connect your own station' }),
  ).toHaveAttribute('href', '/weather?connect=station');

  await page.goto(`/data/compare?plant=seed:${fx.seedId}`);
  const seasons = page.getByRole('region', { name: 'Season by season' });
  await expect(seasons.getByRole('button', { name: 'Chart' })).toHaveAttribute('aria-pressed', 'true');
  await expect(seasons.getByRole('button', { name: `${fx.lastYear} · 400 g` })).toBeVisible();
  await expect(seasons.getByRole('button', { name: new RegExp(`^${fx.thisYear} · 500 g`) })).toBeVisible();
  await expect(seasons.locator('.recharts-bar-rectangle')).toHaveCount(2);

  await seasons.getByRole('button', { name: 'Table' }).click();
  const rows = seasons.getByRole('table').locator('tbody tr').filter({ has: page.getByRole('rowheader') });
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ has: page.getByRole('rowheader', { name: String(fx.lastYear) }) })).toContainText('400 g');
  await expect(rows.filter({ has: page.getByRole('rowheader', { name: String(fx.thisYear) }) })).toContainText('500 g');
});

test('the harvest log offers Compare seasons for that plant', async ({ page }) => {
  await page.goto(`/harvest?seed=seed:${fx.seedId}&season=${fx.thisYear}`);
  await expect(page.getByTestId('harvest-card')).toHaveCount(2);
  const compare = page.getByRole('link', { name: 'Compare seasons' });
  await expect(compare).toBeVisible();
  await expect(compare).toHaveAttribute('href', `/data/compare?plant=${encodeURIComponent(`seed:${fx.seedId}`)}`);
});

test('Export as PDF opens the print page with this season’s entries', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { print: () => void; __printed?: number };
    w.print = () => { w.__printed = (w.__printed ?? 0) + 1; };
  });
  await page.goto('/harvest');
  await expect(page.getByTestId('harvest-card')).toHaveCount(2);

  await page.getByRole('button', { name: 'Export' }).click();
  const panel = page.getByRole('dialog', { name: 'Export harvests' });
  await panel.getByRole('radio', { name: 'PDF' }).check();
  await panel.getByRole('button', { name: 'Download' }).click();

  await expect(page).toHaveURL(/\/harvest\/print(\?|$)/);
  const rows = page.locator('.harvest-print-table tbody tr');
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: '340 g' })).toHaveCount(1);
  await expect(rows.filter({ hasText: '160 g' })).toHaveCount(1);
  // The panel's range defaults to this season, so last season's 400 g is out.
  await expect(rows.filter({ hasText: '400 g' })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __printed?: number }).__printed ?? 0)).toBe(1);
});

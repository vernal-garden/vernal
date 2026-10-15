import { test, expect, request, type Page } from '@playwright/test';
import { resetTestDb, closePool, setSubscriptionTier } from './helpers/db';
import { createMetricsFixture } from './helpers/metrics';
import { signIn } from './helpers/guide';

// Phase 53 mobile sweep: every shell page fits the viewport width and every
// visible button, link and form control is at least 44x44. Runs only in the
// 'mobile' (Pixel 7) project — see playwright.config.ts.
//
// Nothing is dismissed first: what a user sees on arrival is what is measured
// (e.g. the canvas editing note on /).

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:4173';
const EMAIL = 'mobile-sweep@example.com';
const PASSWORD = 'MobileSweep123!';
const MIN_TARGET = 44;
// Subpixel layout can put a 44px box at 43.6 or so.
const TOLERANCE = 0.5;

let gardenId: string;

// A supporter with one garden holding a bed, a dated planting (guide marked
// done), three harvests (createMetricsFixture), a soil reading and an
// amendment — enough for every page to render its normal content rather than
// an empty state. The location is put back to 'Test City' (the fixture clears
// it) so /weather and the /data weather card render their normal forecast
// layout. The forecast service itself is never called: the browser's weather
// requests are stubbed per test (see stubWeather below).
test.beforeAll(async () => {
  await resetTestDb();
  const fixture = await createMetricsFixture(EMAIL, PASSWORD, 'Sweep Tomato');
  gardenId = fixture.gardenId;
  await setSubscriptionTier(fixture.accountId, 'supporter');

  const api = await request.newContext({ baseURL: BASE_URL });
  try {
    expect((await api.post('/api/auth/login', { data: { email: EMAIL, password: PASSWORD } })).ok()).toBe(true);
    expect((await api.patch('/api/me', { data: { zoneLocationLabel: 'Test City' } })).ok()).toBe(true);
    const testDate = fixture.firstDate;
    const reading = await api.post(`/api/gardens/${gardenId}/soil-readings`, {
      data: { bedId: fixture.bedId, testDate, ph: 6.5 },
    });
    expect(reading.status(), await reading.text()).toBe(201);
    const amendment = await api.post(`/api/gardens/${gardenId}/amendments`, {
      data: {
        bedIds: [fixture.bedId], applicationDate: testDate,
        productName: 'Sweep Bone Meal', amendmentType: 'fertilizer_organic',
      },
    });
    expect(amendment.status(), await amendment.text()).toBe(201);
  } finally {
    await api.dispose();
  }
});
test.afterAll(closePool);

// The server fetches the forecast from an external service, so the browser's
// own /api calls are stubbed instead. /weather reads /api/weather/current and
// /api/weather/history; the /data weather card reads `paid.weather` from
// /api/metrics/dashboard, which is fetched for real and has only that field
// replaced.
async function stubWeather(page: Page): Promise<void> {
  const ymd = (daysAgo: number): string => {
    const d = new Date(Date.now() - daysAgo * 86_400_000);
    return d.toISOString().slice(0, 10);
  };
  const history = Array.from({ length: 7 }, (_, i) => ({
    date: ymd(7 - i),
    tempMaxC: 22 + (i % 3),
    tempMinC: 11 + (i % 2),
    precipMm: i === 2 ? 4.2 : 0,
  }));

  await page.route('**/api/weather/current', route => route.fulfill({
    json: {
      readingTimestamp: new Date().toISOString(),
      temperature: 21.5,
      humidity: 58,
      windSpeed: 12,
      windDirection: 'NW',
      precipitationToday: 0,
      uvIndex: 5,
      pressure: 1015,
      source: 'public_weather',
      cached: false,
    },
  }));
  await page.route('**/api/weather/history', route => route.fulfill({
    json: {
      data: history,
      insights: [
        { kind: 'warming', maxHighC: 24 },
        { kind: 'steady', minLowC: 11, maxHighC: 24 },
      ],
    },
  }));
  await page.route('**/api/metrics/dashboard**', async route => {
    const response = await route.fetch();
    const body = await response.json();
    if (body.paid) {
      body.paid.weather = {
        station: null,
        locationLabel: 'Test City',
        units: body.paid.weather?.units ?? 'imperial',
        week: { minLowC: 11, maxHighC: 24, precipMm: 4.2, days: 7 },
        insights: [{ kind: 'warming', maxHighC: 24 }],
        historyUnavailable: false,
      };
    }
    await route.fulfill({ response, json: body });
  });
}

interface PageAudit {
  scrollWidth: number;
  innerWidth: number;
  offenders: string[];
}

// Runs in the page. "Visible" mirrors Playwright's isVisible (non-empty box,
// not visibility:hidden / display:none), minus anything inside an
// aria-hidden subtree and visually-hidden elements (sr-only / clipped / 1x1).
async function auditPage(page: Page): Promise<PageAudit> {
  return page.evaluate(({ min, tolerance }) => {
    const SELECTOR = [
      'button', 'a[href]', 'input:not([type="hidden"])', 'select', 'textarea',
      '[role="button"]', '[role="link"]',
    ].join(', ');

    const visuallyHidden = (el: Element, rect: DOMRect): boolean => {
      if (rect.width <= 1 || rect.height <= 1) return true;
      for (let node: Element | null = el; node; node = node.parentElement) {
        if (node.classList.contains('sr-only') || node.classList.contains('visually-hidden')) return true;
        const cs = getComputedStyle(node);
        if (cs.position === 'absolute' && /^rect\(0(px)?,? 0(px)?,? 0(px)?,? 0(px)?\)$/.test(cs.clip)) return true;
        if (cs.clipPath === 'inset(50%)') return true;
      }
      return false;
    };

    const textOf = (el: Element | null): string => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

    const nameOf = (el: Element): string => {
      const aria = el.getAttribute('aria-label');
      if (aria?.trim()) return aria.trim();
      const labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy) {
        const t = labelledBy.split(/\s+/).map(id => textOf(document.getElementById(id))).join(' ').trim();
        if (t) return t;
      }
      if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
        const label = el.labels?.[0];
        if (label && textOf(label)) return textOf(label);
        if ('placeholder' in el && el.placeholder) return el.placeholder;
        if (el instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(el.type) && el.value) return el.value;
      }
      const text = textOf(el);
      if (text) return text;
      const title = el.getAttribute('title');
      if (title) return title;
      const alt = el.querySelector('img[alt]')?.getAttribute('alt');
      if (alt) return alt;
      return '(unnamed)';
    };

    const describe = (el: Element): string => {
      const tag = el.tagName.toLowerCase();
      const type = el instanceof HTMLInputElement ? `[type=${el.type}]` : '';
      const role = el.getAttribute('role') ? `[role=${el.getAttribute('role')}]` : '';
      return `<${tag}${type}${role}>`;
    };

    const offenders: string[] = [];
    for (const el of Array.from(document.querySelectorAll(SELECTOR))) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (!el.checkVisibility({ visibilityProperty: true })) continue;
      if (el.closest('[aria-hidden="true"]')) continue;
      if (visuallyHidden(el, rect)) continue;
      if (rect.width < min - tolerance || rect.height < min - tolerance) {
        const name = nameOf(el);
        offenders.push(
          `"${name.length > 60 ? `${name.slice(0, 57)}…` : name}" ${describe(el)} `
          + `${rect.width.toFixed(1)}x${rect.height.toFixed(1)}`,
        );
      }
    }
    return {
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      offenders,
    };
  }, { min: MIN_TARGET, tolerance: TOLERANCE });
}

async function sweep(page: Page, label: string): Promise<void> {
  // Let async page content settle before measuring.
  await page.waitForLoadState('networkidle');
  const audit = await auditPage(page);
  expect.soft(audit.scrollWidth, `${label} overflows horizontally`).toBeLessThanOrEqual(audit.innerWidth);
  expect.soft(audit.offenders, `${label}: targets smaller than ${MIN_TARGET}x${MIN_TARGET}`).toEqual([]);
}

// Signed-in pages, with the top-bar title each settles on.
const SIGNED_IN: Array<{ path: () => string; title: string }> = [
  { path: () => '/', title: 'Garden' },
  { path: () => '/gardens', title: 'My Gardens' },
  { path: () => '/catalogue', title: 'Seed Catalogue' },
  { path: () => '/guide', title: 'Planting Guide' },
  { path: () => '/harvest', title: 'Harvest' },
  { path: () => '/data', title: 'Data' },
  { path: () => '/account', title: 'Account' },
  { path: () => '/about', title: 'About' },
  { path: () => '/weather', title: 'Weather' },
  { path: () => `/garden/${gardenId}/soil`, title: 'Soil' },
  { path: () => `/garden/${gardenId}/amendments`, title: 'Amendments' },
];

test.describe('signed in', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, EMAIL, PASSWORD);
  });

  for (const { path, title } of SIGNED_IN) {
    test(`${title} page fits the width and has 44px targets`, async ({ page }) => {
      const url = path();
      await stubWeather(page);
      await page.goto(url);
      await expect.poll(() => new URL(page.url()).pathname).toBe(url);
      await expect(page.getByRole('banner').getByText(title, { exact: true }).first()).toBeVisible();
      if (url === '/') {
        // The mobile canvas chrome, editing note included, is part of the sweep.
        await expect(page.getByRole('button', { name: 'Zoom in' })).toBeVisible();
        await expect(page.getByRole('note', { name: 'Editing note' })).toBeVisible();
      }
      if (url === '/weather') {
        // Guard against sweeping the error/empty state if the stub breaks.
        await expect(page.getByRole('heading', { name: 'Past 7 days' })).toBeVisible();
        await expect(page.getByRole('heading', { name: 'Growing insights' })).toBeVisible();
        await expect(page.getByText('Temperature', { exact: true })).toBeVisible();
      }
      if (url === '/data') {
        const card = page.getByRole('region', { name: 'Weather' });
        await expect(card.getByText(/this week/)).toBeVisible();
      }
      await sweep(page, url);
    });
  }
});

test.describe('signed out', () => {
  for (const url of ['/login', '/register']) {
    test(`${url} fits the width and has 44px targets`, async ({ page }) => {
      await page.goto(url);
      await expect.poll(() => new URL(page.url()).pathname).toBe(url);
      await expect(page.locator('input[type="email"]')).toBeVisible();
      await sweep(page, url);
    });
  }
});

import { test, expect, request, type Page } from '@playwright/test';
import {
  resetTestDb, createTestUser, createTestGarden, createTestCambiumSeed, createCambiumCompanion, deleteCambiumSeedsLike, closePool,
} from './helpers/db';
import { currentSeason, signIn } from './helpers/guide';
import { createGridBedAt } from './helpers/canvasStage';

// Phase 53: the "Send feedback" button never sits on another fixed control on
// the canvas — mobile (390), tablet (800: bottom left, lifted over the
// toolbar) and desktop (1280: bottom right). The account has three gardens
// (garden switcher in the desktop toolbar) and a companion conflict (conflict
// button), the widest the toolbar gets.
//
// Runs in BOTH Playwright projects (chromium and mobile) — see
// playwright.config.ts.

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:4173';
const EMAIL = 'feedback-clearance@example.com';
const PASSWORD = 'FeedbackClear123!';
// cambium.seeds survives resetTestDb: unique names per run.
const STAMP = Date.now();

let gardenId: string;

test.beforeAll(async () => {
  await resetTestDb();
  const season = currentSeason();
  const user = await createTestUser({ email: EMAIL, password: PASSWORD, isSupporter: true });
  gardenId = await createTestGarden(user.id, 'Clearance Garden');
  await createTestGarden(user.id, 'Second Garden');
  await createTestGarden(user.id, 'Third Garden');

  // Two antagonistic companions planted in adjacent cells of one bed.
  const beanId = await createTestCambiumSeed(`Clearance Bean ${STAMP}`);
  const onionId = await createTestCambiumSeed(`Clearance Onion ${STAMP}`);
  await createCambiumCompanion(beanId, onionId, 'antagonistic');

  const api = await request.newContext({ baseURL: BASE_URL });
  try {
    expect((await api.post('/api/auth/login', { data: { email: EMAIL, password: PASSWORD } })).ok()).toBe(true);
    const bedId = await createGridBedAt(api, gardenId, season, 'Conflict Bed', { x: 6, y: 8, cols: 4, rows: 4 });
    for (const [cambiumSeedId, x] of [[beanId, 0], [onionId, 1]] as const) {
      const resp = await api.post(`/api/gardens/${gardenId}/beds/${bedId}/plantings`, {
        data: { cambiumSeedId, quantity: 1, cell: { x, y: 0 } },
      });
      expect(resp.status(), await resp.text()).toBe(201);
    }
  } finally {
    await api.dispose();
  }
});
// The stamp-less patterns also clear seeds left by earlier runs.
test.afterAll(async () => {
  await deleteCambiumSeedsLike('Clearance Bean %', 'Clearance Onion %');
  await closePool();
});

interface Clearance {
  fab: { left: number; top: number; right: number; bottom: number } | null;
  viewport: { width: number; height: number };
  controls: number;
  overlaps: string[];
}

// Runs in the page. "Other fixed controls": visible buttons, links, form
// controls, toolbars and navigation that are position:fixed or inside a
// position:fixed ancestor, plus the fixed containers that hold controls (the
// toolbar pill, the zoom stack, the tab bar) unless they cover half the
// viewport. The feedback widget (and anything containing it) is excluded.
async function measureClearance(page: Page): Promise<Clearance> {
  return page.evaluate(() => {
    const fab = document.querySelector<HTMLElement>('button[aria-label="Send feedback"]');
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    if (!fab) return { fab: null, viewport, controls: 0, overlaps: [] };
    const widget = fab.parentElement ?? fab;
    const fabRect = fab.getBoundingClientRect();

    const CONTROL = [
      'button', 'a[href]', 'input:not([type="hidden"])', 'select', 'textarea',
      '[role="button"]', '[role="link"]', '[role="toolbar"]', '[role="navigation"]', 'nav',
    ].join(', ');

    const visible = (el: Element): boolean => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0
        && el.checkVisibility({ visibilityProperty: true })
        && !el.closest('[aria-hidden="true"]');
    };
    const isFixed = (el: Element) => getComputedStyle(el).position === 'fixed';
    const inFixed = (el: Element): boolean => {
      for (let node: Element | null = el; node; node = node.parentElement) if (isFixed(node)) return true;
      return false;
    };
    const excluded = (el: Element) => widget.contains(el) || el.contains(widget);

    const candidates = new Set<Element>();
    for (const el of Array.from(document.querySelectorAll(CONTROL))) {
      if (!excluded(el) && visible(el) && inFixed(el)) candidates.add(el);
    }
    const half = (viewport.width * viewport.height) / 2;
    for (const el of Array.from(document.querySelectorAll('body *'))) {
      if (excluded(el) || !isFixed(el) || !visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width * r.height >= half) continue;
      if (el.matches(CONTROL) || el.querySelector(CONTROL)) candidates.add(el);
    }

    const label = (el: Element): string => {
      const name = el.getAttribute('aria-label')
        ?? (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
      return `<${el.tagName.toLowerCase()}${el.getAttribute('role') ? ` role=${el.getAttribute('role')}` : ''}> "${name}"`;
    };

    const overlaps: string[] = [];
    for (const el of candidates) {
      const r = el.getBoundingClientRect();
      const w = Math.min(r.right, fabRect.right) - Math.max(r.left, fabRect.left);
      const h = Math.min(r.bottom, fabRect.bottom) - Math.max(r.top, fabRect.top);
      // Touching edges (or a subpixel sliver) is not an overlap.
      if (w > 0.5 && h > 0.5) {
        overlaps.push(`${label(el)} at (${r.left.toFixed(0)}, ${r.top.toFixed(0)}, ${r.width.toFixed(0)}x${r.height.toFixed(0)})`);
      }
    }
    return {
      fab: { left: fabRect.left, top: fabRect.top, right: fabRect.right, bottom: fabRect.bottom },
      viewport,
      controls: candidates.size,
      overlaps,
    };
  });
}

const WIDTHS = [
  { width: 390, height: 844, layout: 'mobile' },
  { width: 800, height: 1000, layout: 'tablet' },
  { width: 1280, height: 800, layout: 'desktop' },
] as const;

test.beforeEach(async ({ page }) => {
  await signIn(page, EMAIL, PASSWORD);
});

for (const { width, height, layout } of WIDTHS) {
  test(`at ${width}px the feedback button clears every fixed canvas control`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto(`/?garden=${gardenId}`);

    const fab = page.getByRole('button', { name: 'Send feedback' });
    await expect(fab).toBeVisible();
    if (layout === 'mobile') {
      await expect(page.getByRole('button', { name: 'Zoom in' })).toBeVisible();
      await expect(page.getByRole('button', { name: /^Season: / })).toBeVisible();
      await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
    } else {
      // Widest toolbar: garden switcher plus the conflict button.
      await expect(page.getByRole('button', { name: /companion conflicts?$/ })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole('button', { name: 'Third Garden' })).toBeVisible();
    }
    await page.waitForLoadState('networkidle');

    const result = await measureClearance(page);
    expect(result.fab, 'feedback button not found').not.toBeNull();
    expect(result.controls, 'no other fixed controls were found to compare against').toBeGreaterThan(0);
    // Inside the viewport.
    expect(result.fab!.left).toBeGreaterThanOrEqual(0);
    expect(result.fab!.top).toBeGreaterThanOrEqual(0);
    expect(result.fab!.right).toBeLessThanOrEqual(result.viewport.width);
    expect(result.fab!.bottom).toBeLessThanOrEqual(result.viewport.height);
    // Side: bottom left with the canvas below 1024px, bottom right otherwise.
    if (width < 1024) expect(result.fab!.left).toBeLessThan(result.viewport.width / 2);
    else expect(result.fab!.right).toBeGreaterThan(result.viewport.width / 2);

    expect(result.overlaps, `feedback button at ${JSON.stringify(result.fab)} overlaps`).toEqual([]);
  });
}

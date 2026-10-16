import { test, expect, request } from '@playwright/test';
import { resetTestDb, createTestUser, createTestGarden, closePool } from './helpers/db';
import { currentSeason, signIn } from './helpers/guide';
import {
  createGridBedAt, describeRect, gridBedScreenRect, rectWithin, stageView,
} from './helpers/canvasStage';

// Phase 53 fitToBeds on desktop: a garden whose only bed is far from the
// origin opens with that bed in view instead of an empty canvas at (0, 0).

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:4173';
const EMAIL = 'canvas-fit@example.com';
const PASSWORD = 'CanvasFit123!';
// 6000 x 4500 world px — far outside any viewport at scale 1 from the origin.
const FAR_BED = { x: 200, y: 150, cols: 4, rows: 4 };

let gardenId: string;

test.beforeAll(async () => {
  await resetTestDb();
  const user = await createTestUser({ email: EMAIL, password: PASSWORD });
  gardenId = await createTestGarden(user.id, 'Far Garden');
  const api = await request.newContext({ baseURL: BASE_URL });
  try {
    expect((await api.post('/api/auth/login', { data: { email: EMAIL, password: PASSWORD } })).ok()).toBe(true);
    await createGridBedAt(api, gardenId, currentSeason(), 'Far Bed', FAR_BED);
  } finally {
    await api.dispose();
  }
});
test.afterAll(closePool);

test('a bed far from the origin is in view when the garden opens', async ({ page }) => {
  await signIn(page, EMAIL, PASSWORD);
  await page.goto(`/?garden=${gardenId}`);
  await expect(page.getByRole('button', { name: 'Zoom in' })).toBeVisible();

  const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  const screen = { left: 0, top: 0, right: viewport.width, bottom: viewport.height };
  await expect.poll(async () => {
    const view = await stageView(page);
    if (!view) return 'no stage';
    const bed = gridBedScreenRect(view, FAR_BED);
    return rectWithin(bed, screen) ? 'ok' : `bed at ${describeRect(bed)} outside ${describeRect(screen)}`;
  }, { timeout: 10_000 }).toBe('ok');

  // A single small bed fits at the 1x cap rather than being blown up.
  expect((await stageView(page))!.scale).toBeCloseTo(1, 5);
});

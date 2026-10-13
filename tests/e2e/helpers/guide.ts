import { expect, request, type APIRequestContext, type Page } from '@playwright/test';
import { createTestGarden, createTestSeed, createTestUser } from './db';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:4173';

// The server's season is the calendar year in America/Los_Angeles.
export function currentSeason(): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric' })
    .format(new Date()));
}

export async function addPlanting(
  api: APIRequestContext,
  gardenId: string,
  season: number,
  seed: { seedId?: number; cambiumSeedId?: number },
  cellX: number,
): Promise<void> {
  const bedResp = await api.post(`/api/gardens/${gardenId}/beds`, {
    data: { type: 'grid', label: `Bed ${season}-${cellX}`, season, grid: { x: cellX * 5, y: 0, cols: 4, rows: 4 } },
  });
  expect(bedResp.status()).toBe(201);
  const bed = await bedResp.json();
  const plantingResp = await api.post(`/api/gardens/${gardenId}/beds/${bed.id}/plantings`, {
    data: { ...seed, quantity: 1, cell: { x: 0, y: 0 } },
  });
  expect(plantingResp.status()).toBe(201);
}

export interface GuideFixture {
  email: string;
  password: string;
  season: number;
  timedSeedId: number;
}

// An account with a last spring frost date, one garden, and two plantings in
// the current season: a timed seed (indoor start + transplant + harvest) and
// one with no timing data. The timed seed is also planted last season so the
// read-only past season has a row.
export async function createGuideFixture(email: string, password: string): Promise<GuideFixture> {
  const season = currentSeason();
  const user = await createTestUser({ email, password });
  const gardenId = await createTestGarden(user.id, 'Guide Garden');
  const timedSeedId = await createTestSeed(user.id, 'Tomato', {
    weeksToTransplant: 6, frostTolerance: 'none', maturityDaysMin: 60, maturityDaysMax: 80,
  });
  const plainSeedId = await createTestSeed(user.id, 'Mystery Herb');

  const api = await request.newContext({ baseURL: BASE_URL });
  try {
    expect((await api.post('/api/auth/login', { data: { email, password } })).ok()).toBe(true);
    expect((await api.patch('/api/me', { data: { lastSpringFrostDate: `${season}-04-15` } })).ok()).toBe(true);
    await addPlanting(api, gardenId, season, { seedId: timedSeedId }, 0);
    await addPlanting(api, gardenId, season, { seedId: plainSeedId }, 1);
    await addPlanting(api, gardenId, season - 1, { seedId: timedSeedId }, 2);
  } finally {
    await api.dispose();
  }
  return { email, password, season, timedSeedId };
}

export async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await expect(page).not.toHaveURL(/\/login/);
}

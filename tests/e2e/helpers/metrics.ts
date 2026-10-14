import { expect, request } from '@playwright/test';
import { createTestGarden, createTestSeed, createTestUser } from './db';
import { currentSeason } from './guide';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:4173';

export interface MetricsFixture {
  accountId: string;
  seedId: number;
  thisYear: number;
  lastYear: number;
  // The two current-season harvest dates (YYYY-MM-DD), earliest first.
  firstDate: string;
  latestDate: string;
}

// Today's date in America/Los_Angeles, as the server sees it.
function todayPacific(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

// Harvests can't be future-dated, so early-January dates are clamped to today.
function notAfterToday(date: string): string {
  const today = todayPacific();
  return date > today ? today : date;
}

// An account with a garden holding one 4x8 grid bed, a timed personal seed
// planted in it this season (with a planting date), the guide marked done,
// and three harvests: 340 g and 160 g this season (linked to the sowing event
// and the bed) and 400 g last season.
export async function createMetricsFixture(
  email: string, password: string, plant: string,
): Promise<MetricsFixture> {
  const thisYear = currentSeason();
  const lastYear = thisYear - 1;
  const user = await createTestUser({ email, password });
  const gardenId = await createTestGarden(user.id, 'Metrics Garden');
  const seedId = await createTestSeed(user.id, plant, {
    weeksToTransplant: 6, frostTolerance: 'none', maturityDaysMin: 60, maturityDaysMax: 80,
  });

  const plantingDate = `${thisYear}-01-01`;
  const firstDate = notAfterToday(`${thisYear}-01-02`);
  const latestDate = notAfterToday(`${thisYear}-01-10`);

  const api = await request.newContext({ baseURL: BASE_URL });
  try {
    expect((await api.post('/api/auth/login', { data: { email, password } })).ok()).toBe(true);
    expect((await api.patch('/api/me', { data: { lastSpringFrostDate: `${thisYear}-04-15` } })).ok()).toBe(true);

    const bedResp = await api.post(`/api/gardens/${gardenId}/beds`, {
      data: { type: 'grid', label: 'Long Bed', season: thisYear, grid: { x: 0, y: 0, cols: 4, rows: 8 } },
    });
    expect(bedResp.status()).toBe(201);
    const bedId = Number((await bedResp.json()).id);

    const plantingResp = await api.post(`/api/gardens/${gardenId}/beds/${bedId}/plantings`, {
      data: { seedId, quantity: 1, cell: { x: 0, y: 0 }, plantingDate },
    });
    expect(plantingResp.status()).toBe(201);

    const doneResp = await api.put('/api/planting-guide/done', {
      data: { gardenId: Number(gardenId), seedId, season: thisYear, done: true },
    });
    expect(doneResp.ok()).toBe(true);
    const sowingEventId = Number((await doneResp.json()).sowingEventId);
    expect(sowingEventId).toBeGreaterThan(0);

    const harvests = [
      { harvestDate: firstDate, quantity: 340, unit: 'g', bedId, sowingEventId },
      { harvestDate: latestDate, quantity: 160, unit: 'g', bedId, sowingEventId },
      { harvestDate: `${lastYear}-06-15`, quantity: 400, unit: 'g' },
    ];
    for (const h of harvests) {
      const resp = await api.post('/api/harvests', { data: { gardenId: Number(gardenId), seedId, ...h } });
      expect(resp.status(), await resp.text()).toBe(201);
    }
  } finally {
    await api.dispose();
  }
  return { accountId: user.id, seedId, thisYear, lastYear, firstDate, latestDate };
}

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "Jan 2" — the dashboard's short date.
export function shortDate(key: string): string {
  const [, m, d] = key.split('-').map(Number);
  return `${MONTH_SHORT[m - 1]} ${d}`;
}

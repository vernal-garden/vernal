import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { Pool } from 'pg';
import { clearMetricsCache } from '../lib/metricsCache';
import { LOCATION_NOT_SET } from '../lib/constants';
import { buildInsights } from '../lib/weather/insights';
import { currentSeason } from '../lib/plantingSchedule';
import type { DailyHistoryPoint } from '../lib/weather/types';
import * as visualCrossing from '../lib/weather/providers/visualCrossing';
import * as geocoder from '../lib/weather/geocode';
import app from '../index';

// The dashboard's weather block geocodes the account location and fetches
// Visual Crossing history; never hit the network from tests.
vi.mock('../lib/weather/geocode', () => ({
  geocode: vi.fn(),
}));
vi.mock('../lib/weather/providers/visualCrossing', () => ({
  fetchCurrent: vi.fn(),
  fetchHistory: vi.fn(),
}));

// A short weather timeout keeps the hanging-fetch test fast.
vi.mock('../lib/metricsConstants', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/metricsConstants')>()),
  WEATHER_TIMEOUT_MS: 50,
}));

const HISTORY: DailyHistoryPoint[] = [
  { date: '2025-06-01', tempMaxC: 20, tempMinC: 10, precipMm: 1 },
  { date: '2025-06-02', tempMaxC: 21, tempMinC: 11, precipMm: 0 },
  { date: '2025-06-03', tempMaxC: 22, tempMinC: 12, precipMm: 2 },
  { date: '2025-06-04', tempMaxC: 23, tempMinC: 12, precipMm: 0 },
];
const HISTORY_WEEK = { minLowC: 10, maxHighC: 23, precipMm: 3, days: 4 };

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL must be set to run tests');

const pool = new Pool({ connectionString: url });

type Agent = ReturnType<typeof request.agent>;
type SeedRef = { seedId?: number; cambiumSeedId?: number };

// Fixed past seasons so nothing depends on today's date.
const S1 = 2024;
const S2 = 2025;
// The weather week and insights are only fetched for the current season.
const NOW = currentSeason(new Date());

async function resetDb() {
  await pool.query(
    `TRUNCATE accounts, guest_sessions, gardens, beds, plantings, seeds, sowing_events,
              harvest_entries, soil_readings, amendment_logs, amendment_log_beds,
              weather_connections, user_seed_preferences RESTART IDENTITY CASCADE`,
  );
  await pool.query('TRUNCATE cambium.seeds RESTART IDENTITY CASCADE');
}

async function createUser(email: string, tier: 'free' | 'supporter' = 'free'): Promise<number> {
  const hash = await bcrypt.hash('Password123!', 4);
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO accounts (email, password_hash, zone, zone_location_label, email_verified)
     VALUES ($1, $2, '7b', 'Test City', true)
     RETURNING id`,
    [email, hash],
  );
  if (tier === 'supporter') {
    await pool.query(`UPDATE accounts SET subscription_tier = 'supporter' WHERE id = $1`, [
      rows[0].id,
    ]);
  }
  return rows[0].id;
}

async function loginAgent(email: string): Promise<Agent> {
  const agent = request.agent(app);
  await agent.post('/api/auth/guest');
  await agent.post('/api/auth/login').send({ email, password: 'Password123!' });
  return agent;
}

// Logs in a fresh account and returns its agent and id.
async function account(
  email: string,
  tier: 'free' | 'supporter' = 'free',
): Promise<{ agent: Agent; accountId: number }> {
  const accountId = await createUser(email, tier);
  return { agent: await loginAgent(email), accountId };
}

async function createGarden(accountId: number, name = 'Garden'): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO gardens (owner_id, name, style, zone) VALUES ($1, $2, 'grid', '7b') RETURNING id`,
    [accountId, name],
  );
  return rows[0].id;
}

async function createBed(
  gardenId: number,
  season: number,
  label = 'Bed',
  cols = 4,
  rows = 8,
): Promise<number> {
  const { rows: r } = await pool.query<{ id: number }>(
    `INSERT INTO beds (garden_id, season, type, label, grid_x, grid_y, grid_cols, grid_rows)
     VALUES ($1, $2, 'grid', $3, 0, 0, $4, $5) RETURNING id`,
    [gardenId, season, label, cols, rows],
  );
  return r[0].id;
}

async function createCambiumSeed(commonName: string, scientificName: string | null = null) {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO cambium.seeds (common_name, scientific_name, source)
     VALUES ($1, $2, 'editorial') RETURNING id`,
    [commonName, scientificName],
  );
  return rows[0].id;
}

async function createPersonalSeed(
  accountId: number,
  commonName: string,
  timing: {
    weeksToTransplant?: number;
    frostTolerance?: string;
    maturityMin?: number;
    maturityMax?: number;
  } = {},
): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO seeds (owner_id, common_name, plant_family, origin,
                        weeks_to_transplant, frost_tolerance, maturity_days_min, maturity_days_max)
     VALUES ($1, $2, 'Fam', 'user_created', $3, $4, $5, $6) RETURNING id`,
    [
      accountId,
      commonName,
      timing.weeksToTransplant ?? null,
      timing.frostTolerance ?? null,
      timing.maturityMin ?? null,
      timing.maturityMax ?? null,
    ],
  );
  return rows[0].id;
}

async function plant(
  bedId: number,
  gardenId: number,
  season: number,
  seed: SeedRef,
  plantingDate: string | null,
): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO plantings (bed_id, garden_id, season, seed_id, cambium_seed_id, planting_date)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [bedId, gardenId, season, seed.seedId ?? null, seed.cambiumSeedId ?? null, plantingDate],
  );
  return rows[0].id;
}

// doneOn is a Pacific calendar date; null leaves the event undone.
async function sowingEvent(
  gardenId: number,
  seed: SeedRef,
  season: number,
  doneOn: string | null,
  plantingId: number | null = null,
): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO sowing_events (planting_id, garden_id, seed_id, cambium_seed_id, season, marked_done_at)
     VALUES ($1, $2, $3, $4, $5,
             CASE WHEN $6::date IS NULL THEN NULL
                  ELSE ($6::date + time '12:00') AT TIME ZONE 'America/Los_Angeles' END)
     RETURNING id`,
    [plantingId, gardenId, seed.seedId ?? null, seed.cambiumSeedId ?? null, season, doneOn],
  );
  return rows[0].id;
}

async function harvest(
  gardenId: number,
  seed: SeedRef,
  date: string,
  quantity: number | null = null,
  unit: string | null = null,
  extra: { bedId?: number; sowingEventId?: number; notes?: string } = {},
): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO harvest_entries
       (garden_id, bed_id, seed_id, cambium_seed_id, harvested_at, quantity, unit, notes, sowing_event_id)
     VALUES ($1, $2, $3, $4, ($5::date + time '12:00') AT TIME ZONE 'America/Los_Angeles',
             $6, $7, $8, $9)
     RETURNING id`,
    [
      gardenId,
      extra.bedId ?? null,
      seed.seedId ?? null,
      seed.cambiumSeedId ?? null,
      date,
      quantity,
      unit,
      extra.notes ?? null,
      extra.sowingEventId ?? null,
    ],
  );
  return rows[0].id;
}

async function dashboard(agent: Agent, query: Record<string, string | number> = {}) {
  const res = await agent.get('/api/metrics/dashboard').query(query);
  expect(res.status).toBe(200);
  return res.body;
}

beforeAll(async () => {
  await resetDb();
});

beforeEach(() => {
  clearMetricsCache();
  vi.mocked(geocoder.geocode).mockReset().mockResolvedValue({ lat: 45.5, lon: -122.7 });
  vi.mocked(visualCrossing.fetchHistory).mockReset().mockResolvedValue(HISTORY);
});

afterAll(async () => {
  await pool.end();
});

// ── Auth ──────────────────────────────────────────────────────────────────────

describe('auth', () => {
  it('401 for guests on every route', async () => {
    const guest = request.agent(app);
    await guest.post('/api/auth/guest').expect(201);
    for (const path of [
      '/api/metrics/dashboard',
      '/api/metrics/comparable-plants',
      '/api/metrics/cross-season?plant=seed:1',
    ]) {
      const res = await guest.get(path);
      expect(res.status, path).toBe(401);
    }
  });

  it('401 with no session at all', async () => {
    const res = await request(app).get('/api/metrics/dashboard');
    expect(res.status).toBe(401);
  });

  it('cross-season is 402 for a free account', async () => {
    const { agent } = await account('auth-free@example.com');
    const res = await agent.get('/api/metrics/cross-season?plant=seed:1');
    expect(res.status).toBe(402);
    expect(res.body.upgrade_required).toBe(true);
  });

  it('validates season and gardenId', async () => {
    const { agent, accountId } = await account('auth-validate@example.com');
    expect((await agent.get('/api/metrics/dashboard?season=1999')).status).toBe(400);
    expect((await agent.get('/api/metrics/dashboard?season=abc')).status).toBe(400);
    expect((await agent.get('/api/metrics/dashboard?gardenId=x')).status).toBe(400);

    const other = await createUser('auth-other@example.com');
    const otherGarden = await createGarden(other);
    expect((await agent.get(`/api/metrics/dashboard?gardenId=${otherGarden}`)).status).toBe(404);

    const own = await createGarden(accountId);
    expect((await agent.get(`/api/metrics/dashboard?gardenId=${own}`)).status).toBe(200);
  });
});

// ── Totals, summary, empty, recent ────────────────────────────────────────────

describe('totals and summary', () => {
  let agent: Agent;
  let g1: number;
  let g2: number;
  let peaId: number;

  beforeAll(async () => {
    const a = await account('totals@example.com');
    agent = a.agent;
    g1 = await createGarden(a.accountId, 'North');
    g2 = await createGarden(a.accountId, 'South');

    const bean = await createPersonalSeed(a.accountId, 'Bean');
    const squash = await createPersonalSeed(a.accountId, 'Squash');
    const herb = await createPersonalSeed(a.accountId, 'Herb');
    const garlic = await createPersonalSeed(a.accountId, 'Garlic');
    peaId = await createCambiumSeed('Pea', 'Pisum sativum');

    // Bean: g, g, oz → 150 g, mixed units.
    await harvest(g1, { seedId: bean }, `${S1}-06-01`, 100, 'g');
    await harvest(g1, { seedId: bean }, `${S1}-06-10`, 50, 'g');
    await harvest(g1, { seedId: bean }, `${S1}-06-20`, 3, 'oz');
    // Two plants in oz, one in g: the oz group comes first despite the alphabet.
    await harvest(g1, { seedId: squash }, `${S1}-08-01`, 10, 'oz');
    await harvest(g2, { cambiumSeedId: peaId }, `${S1}-05-15`, 4, 'oz');
    // No quantities at all.
    await harvest(g1, { seedId: herb }, `${S1}-07-01`);
    await harvest(g1, { seedId: herb }, `${S1}-07-02`);
    await harvest(g1, { seedId: garlic }, `${S1}-07-03`);
  });

  it('builds per-plant totals in the dominant unit, grouped and ordered', async () => {
    const body = await dashboard(agent, { season: S1 });
    expect(body.totals.map((t: { commonName: string }) => t.commonName)).toEqual([
      'Squash',
      'Pea',
      'Bean',
      'Herb',
      'Garlic',
    ]);
    const bean = body.totals.find((t: { commonName: string }) => t.commonName === 'Bean');
    expect(bean).toMatchObject({ total: 150, unit: 'g', mixedUnits: true, entryCount: 3 });
    expect(typeof bean.seedId).toBe('string');
    expect(bean.cambiumSeedId).toBeNull();

    const pea = body.totals.find((t: { commonName: string }) => t.commonName === 'Pea');
    expect(pea).toMatchObject({
      seedId: null,
      cambiumSeedId: String(peaId),
      total: 4,
      unit: 'oz',
      mixedUnits: false,
    });

    const herb = body.totals.find((t: { commonName: string }) => t.commonName === 'Herb');
    expect(herb).toMatchObject({ total: null, unit: null, mixedUnits: false, entryCount: 2 });
  });

  it('summary covers the season across all gardens', async () => {
    const body = await dashboard(agent, { season: S1 });
    expect(body).toMatchObject({
      season: S1,
      readOnly: true,
      isSupporter: false,
      empty: false,
      summary: { harvestCount: 8, firstHarvestDate: `${S1}-05-15`, lastHarvestDate: `${S1}-08-01` },
      paid: null,
    });
    expect(body.gardens).toEqual([
      { id: String(g1), name: 'North' },
      { id: String(g2), name: 'South' },
    ]);
  });

  it('gardenId filters totals only', async () => {
    const body = await dashboard(agent, { season: S1, gardenId: g2 });
    expect(body.totals).toHaveLength(1);
    expect(body.totals[0].commonName).toBe('Pea');
    expect(body.summary.harvestCount).toBe(8);
    expect(body.recent).toHaveLength(5);
  });

  it('a dominant-unit tie goes to the alphabetically first unit', async () => {
    const { agent, accountId } = await account('totals-tie@example.com');
    const g = await createGarden(accountId);
    const seed = await createPersonalSeed(accountId, 'Chard');
    await harvest(g, { seedId: seed }, `${S1}-06-01`, 5, 'oz');
    await harvest(g, { seedId: seed }, `${S1}-06-02`, 120, 'g');
    const body = await dashboard(agent, { season: S1 });
    expect(body.totals).toEqual([
      {
        seedId: String(seed),
        cambiumSeedId: null,
        commonName: 'Chard',
        total: 120,
        unit: 'g',
        mixedUnits: true,
        entryCount: 2,
      },
    ]);
  });

  it('a season with nothing is empty', async () => {
    const body = await dashboard(agent, { season: 2020 });
    expect(body.empty).toBe(true);
    expect(body.summary).toEqual({ harvestCount: 0, firstHarvestDate: null, lastHarvestDate: null });
    expect(body.totals).toEqual([]);
    expect(body.timing).toEqual([]);
  });

  it('a done sowing event alone makes a season non-empty', async () => {
    await sowingEvent(g1, { cambiumSeedId: peaId }, 2021, '2021-04-01');
    const body = await dashboard(agent, { season: 2021 });
    expect(body.empty).toBe(false);
    expect(body.summary.harvestCount).toBe(0);
  });
});

describe('recent', () => {
  it('spans seasons, newest first, capped at 5', async () => {
    const { agent, accountId } = await account('recent@example.com');
    const g = await createGarden(accountId, 'Plot');
    const bed = await createBed(g, S2, 'East');
    const seed = await createPersonalSeed(accountId, 'Carrot');
    await harvest(g, { seedId: seed }, '2022-06-01', 1, 'kg');
    await harvest(g, { seedId: seed }, '2023-06-01', 2, 'kg');
    await harvest(g, { seedId: seed }, `${S1}-06-01`, 3, 'kg');
    await harvest(g, { seedId: seed }, `${S1}-07-01`);
    await harvest(g, { seedId: seed }, `${S2}-06-01`, 5, 'kg', { bedId: bed });
    await harvest(g, { seedId: seed }, `${S2}-07-01`, 6, 'kg');

    const body = await dashboard(agent, { season: S1 });
    expect(body.recent).toHaveLength(5);
    expect(body.recent.map((r: { harvestDate: string }) => r.harvestDate)).toEqual([
      `${S2}-07-01`,
      `${S2}-06-01`,
      `${S1}-07-01`,
      `${S1}-06-01`,
      '2023-06-01',
    ]);
    expect(body.recent[1]).toMatchObject({
      commonName: 'Carrot',
      quantity: 5,
      unit: 'kg',
      gardenName: 'Plot',
      bedLabel: 'East',
    });
    expect(body.recent[2]).toMatchObject({ quantity: null, unit: null, bedLabel: null });
  });
});

// ── Timing ────────────────────────────────────────────────────────────────────

describe('timing', () => {
  // Last spring frost 2025-04-15. A frost-tender direct-sow seed's window is
  // frost + 7 .. frost + 28 = 04-22 .. 05-13 (widened: 04-15 .. 05-20). A seed
  // with 6 weeks to transplant starts indoors 02-25 .. 03-11.
  const DIRECT = { frostTolerance: 'none', maturityMin: 50, maturityMax: 60 };
  let body: {
    timing: Array<Record<string, unknown>>;
    paid: { advanced: { daysToHarvest: Array<Record<string, unknown>> } } | null;
  };
  let gardenId: number;

  beforeAll(async () => {
    const { agent, accountId } = await account('timing@example.com', 'supporter');
    await pool.query(
      `UPDATE accounts SET last_spring_frost_date = '2025-04-15', first_fall_frost_date = '2025-10-15'
       WHERE id = $1`,
      [accountId],
    );
    gardenId = await createGarden(accountId, 'Plot');
    const bed = await createBed(gardenId, S2);

    // Sown, done and harvested, with a planting_date.
    const sown = async (
      name: string,
      plantingDate: string,
      timing: Parameters<typeof createPersonalSeed>[2] = DIRECT,
    ) => {
      const seedId = await createPersonalSeed(accountId, name, timing);
      const p = await plant(bed, gardenId, S2, { seedId }, plantingDate);
      const ev = await sowingEvent(gardenId, { seedId }, S2, '2025-05-02', p);
      await harvest(gardenId, { seedId }, '2025-06-25', 1, 'kg', { sowingEventId: ev });
      return seedId;
    };

    await sown('Early', '2025-04-01'); // 21 days before the window start
    await sown('Edge', '2025-04-15'); // exactly 7 days before
    await sown('Inside', '2025-05-01');
    await sown('Late', '2025-06-10'); // 21 days after the widened end → 3 weeks
    await sown('Transplant', '2025-03-01', { frostTolerance: 'none', weeksToTransplant: 6 });

    // No planting_date: falls back to the day it was marked done.
    const noDate = await createPersonalSeed(accountId, 'NoDate', DIRECT);
    const p = await plant(bed, gardenId, S2, { seedId: noDate }, null);
    const ev = await sowingEvent(gardenId, { seedId: noDate }, S2, '2025-05-05', p);
    await harvest(gardenId, { seedId: noDate }, '2025-06-29', 2, 'kg', { sowingEventId: ev });

    // Undone event with a linked harvest: excluded.
    const undone = await createPersonalSeed(accountId, 'Undone', DIRECT);
    const ue = await sowingEvent(gardenId, { seedId: undone }, S2, null);
    await harvest(gardenId, { seedId: undone }, '2025-06-01', 1, 'kg', { sowingEventId: ue });

    // Done event no harvest links to: excluded.
    const unlinked = await createPersonalSeed(accountId, 'Unlinked', DIRECT);
    await sowingEvent(gardenId, { seedId: unlinked }, S2, '2025-05-01');
    await harvest(gardenId, { seedId: unlinked }, '2025-06-01', 1, 'kg');

    body = await dashboard(agent, { season: S2 });
    timingAgent = agent;
    emptyGarden = await createGarden(accountId, 'Empty');
  });

  let timingAgent: Agent;
  let emptyGarden: number;

  it('gardenId does not filter timing or daysToHarvest', async () => {
    const filtered = await dashboard(timingAgent, { season: S2, gardenId: emptyGarden });
    expect(filtered.totals).toEqual([]);
    expect(filtered.timing).toEqual(body.timing);
    expect(filtered.paid.advanced.daysToHarvest).toEqual(body.paid!.advanced.daysToHarvest);
  });

  function row(name: string) {
    return body.timing.find((t) => t.commonName === name);
  }

  it('only done events with a linked harvest appear', () => {
    expect(body.timing.map((t) => t.commonName)).toEqual([
      'Early',
      'Edge',
      'Inside',
      'Late',
      'NoDate',
      'Transplant',
    ]);
  });

  it('21 days before the window start is early by 2 weeks', () => {
    expect(row('Early')).toMatchObject({
      gardenId: String(gardenId),
      cambiumSeedId: null,
      sowDate: '2025-04-01',
      sowDateSource: 'planting',
      window: { name: 'directSow', start: '2025-04-22', end: '2025-05-13' },
      status: 'early',
      weeks: 2,
    });
  });

  it('exactly 7 days before the start and inside the window are on time', () => {
    expect(row('Edge')).toMatchObject({ status: 'on_time', weeks: 0 });
    expect(row('Inside')).toMatchObject({ status: 'on_time', weeks: 0 });
  });

  it('after the widened window is late', () => {
    expect(row('Late')).toMatchObject({ status: 'late', weeks: 3 });
  });

  it('a seed with weeks_to_transplant uses the indoor start window', () => {
    expect(row('Transplant')).toMatchObject({
      window: { name: 'indoorStart', start: '2025-02-25', end: '2025-03-11' },
      status: 'on_time',
    });
  });

  it('no planting_date uses the day it was marked done', () => {
    expect(row('NoDate')).toMatchObject({
      sowDate: '2025-05-05',
      sowDateSource: 'marked_done',
      status: 'on_time',
    });
  });

  it('daysToHarvest compares first harvest against maturity days', () => {
    const d = body.paid!.advanced.daysToHarvest;
    // Transplant has no maturity days, so it's left out.
    expect(d.map((r) => r.commonName)).toEqual(['Early', 'Edge', 'Inside', 'Late', 'NoDate']);
    // 04-01 → 06-25 = 85 days, past 50–60.
    expect(d[0]).toMatchObject({ actualDays: 85, predictedMin: 50, predictedMax: 60, status: 'late' });
    // 06-10 → 06-25 = 15 days.
    expect(d[3]).toMatchObject({ actualDays: 15, status: 'early' });
    // 05-05 → 06-29 = 55 days.
    expect(d[4]).toMatchObject({ actualDays: 55, status: 'on_time' });
  });
});

// ── Days to harvest: linked sowing event only ────────────────────────────────

describe('days to harvest uses the linked sowing event', () => {
  // One garden, one plant, two done sowing events. The first (lower id) is
  // the timing candidate: sown 05-01, its linked harvest 06-25 (55 days). The
  // second event's linked harvest, 04-20, comes before any of the first's.
  let agent: Agent;
  let seedId: number;

  beforeAll(async () => {
    const a = await account('linked-sowing@example.com', 'supporter');
    agent = a.agent;
    await pool.query(
      `UPDATE accounts SET last_spring_frost_date = '2025-04-15', first_fall_frost_date = '2025-10-15'
       WHERE id = $1`,
      [a.accountId],
    );
    const gardenId = await createGarden(a.accountId, 'Plot');
    const bed = await createBed(gardenId, S2);
    seedId = await createPersonalSeed(a.accountId, 'Bean', {
      frostTolerance: 'none',
      maturityMin: 50,
      maturityMax: 60,
    });

    const p1 = await plant(bed, gardenId, S2, { seedId }, '2025-05-01');
    const ev1 = await sowingEvent(gardenId, { seedId }, S2, '2025-05-02', p1);
    const p2 = await plant(bed, gardenId, S2, { seedId }, '2025-03-01');
    const ev2 = await sowingEvent(gardenId, { seedId }, S2, '2025-03-02', p2);

    await harvest(gardenId, { seedId }, '2025-04-20', 1, 'kg', { sowingEventId: ev2 });
    await harvest(gardenId, { seedId }, '2025-06-25', 1, 'kg', { sowingEventId: ev1 });
    await harvest(gardenId, { seedId }, '2025-07-05', 1, 'kg', { sowingEventId: ev1 });
    // A prior season so the plant is comparable.
    await harvest(gardenId, { seedId }, `${S1}-07-01`, 1, 'kg');
  });

  it("dashboard daysToHarvest counts only the first event's harvests", async () => {
    const body = await dashboard(agent, { season: S2 });
    expect(body.timing).toHaveLength(1);
    expect(body.timing[0]).toMatchObject({ sowDate: '2025-05-01' });
    const d = body.paid.advanced.daysToHarvest;
    expect(d).toHaveLength(1);
    // 05-01 → 06-25, not 05-01 → 04-20.
    expect(d[0]).toMatchObject({ commonName: 'Bean', actualDays: 55, status: 'on_time' });
    expect(d[0].actualDays).toBeGreaterThan(0);
  });

  it("cross-season daysToFirstHarvest comes from the chosen event's entries", async () => {
    const res = await agent.get(`/api/metrics/cross-season?plant=seed:${seedId}`);
    expect(res.status).toBe(200);
    const s2 = res.body.seasons.find((s: { season: number }) => s.season === S2);
    expect(s2.sowing).toEqual({
      sowDate: '2025-05-01',
      sowDateSource: 'planting',
      daysToFirstHarvest: 55,
    });
  });
});

// ── Trend ─────────────────────────────────────────────────────────────────────

describe('trend', () => {
  it('is hidden with no harvests at all', async () => {
    const { agent } = await account('trend-none@example.com');
    const body = await dashboard(agent, { season: S2 });
    expect(body.trend).toEqual({ state: 'hidden', comparedSeason: null, plants: [] });
  });

  it("is 'one_season' with only one season of harvests", async () => {
    const { agent, accountId } = await account('trend-one@example.com');
    const g = await createGarden(accountId);
    const seed = await createPersonalSeed(accountId, 'Tomato');
    await harvest(g, { seedId: seed }, `${S2}-07-01`, 500, 'g');
    const body = await dashboard(agent, { season: S2 });
    expect(body.trend).toEqual({ state: 'one_season', comparedSeason: null, plants: [] });
  });

  it('compares with the previous season with data', async () => {
    const { agent, accountId } = await account('trend-two@example.com');
    const g = await createGarden(accountId);
    const tomato = await createPersonalSeed(accountId, 'Tomato');
    const lettuce = await createPersonalSeed(accountId, 'Lettuce');
    const kale = await createPersonalSeed(accountId, 'Kale');

    // +25%: 400 → 500 g.
    await harvest(g, { seedId: tomato }, '2023-07-01', 400, 'g');
    await harvest(g, { seedId: tomato }, `${S2}-07-01`, 340, 'g');
    await harvest(g, { seedId: tomato }, `${S2}-07-15`, 160, 'g');
    // +5%: about the same.
    await harvest(g, { seedId: lettuce }, '2023-06-01', 200, 'g');
    await harvest(g, { seedId: lettuce }, `${S2}-06-01`, 210, 'g');
    // Unit changed between seasons: excluded.
    await harvest(g, { seedId: kale }, '2023-06-01', 10, 'oz');
    await harvest(g, { seedId: kale }, `${S2}-06-01`, 300, 'g');

    const body = await dashboard(agent, { season: S2 });
    expect(body.trend.state).toBe('ready');
    // 2023 is the latest season below 2025 that has harvests.
    expect(body.trend.comparedSeason).toBe(2023);
    expect(body.trend.plants).toEqual([
      { seedId: String(tomato), cambiumSeedId: null, commonName: 'Tomato', changePct: 25, direction: 'up' },
      { seedId: String(lettuce), cambiumSeedId: null, commonName: 'Lettuce', changePct: 5, direction: 'same' },
    ]);
  });
});

// ── Paid section ──────────────────────────────────────────────────────────────

describe('paid', () => {
  it('is null for a free account', async () => {
    const { agent } = await account('paid-free@example.com');
    const body = await dashboard(agent, { season: S2 });
    expect(body.isSupporter).toBe(false);
    expect(body.paid).toBeNull();
  });

  it('reports soil, amendments, weather and advanced metrics for a supporter', async () => {
    const { agent, accountId } = await account('paid-supporter@example.com', 'supporter');
    const g = await createGarden(accountId, 'Plot');
    const bedA = await createBed(g, S2, 'A', 4, 8); // 32 sq ft
    const bedB = await createBed(g, S2, 'B');
    const bedC = await createBed(g, S2, 'C');
    const bedD = await createBed(g, S2, 'D');
    const oldBed = await createBed(g, S1, 'Old');

    const reading = (bedId: number, date: string, ph: number | null) =>
      pool.query(
        `INSERT INTO soil_readings (user_id, garden_id, bed_id, test_date, ph)
         VALUES ($1, $2, $3, $4, $5)`,
        [accountId, g, bedId, date, ph],
      );
    await reading(bedA, `${S2}-03-01`, 5.0);
    await reading(bedA, `${S2}-05-01`, 6.5); // latest wins → balanced
    await reading(bedB, `${S2}-04-01`, 7.8); // needs attention
    await reading(bedC, `${S2}-04-01`, null); // no pH
    await reading(bedD, `${S1}-04-01`, 6.5); // other season → bed omitted
    await reading(oldBed, `${S2}-04-01`, 6.5); // last season's bed → omitted

    const amendment = async (date: string, beds: number[]) => {
      const { rows } = await pool.query<{ id: number }>(
        `INSERT INTO amendment_logs (user_id, garden_id, application_date, product_name, amendment_type)
         VALUES ($1, $2, $3, 'Compost', 'compost_manure') RETURNING id`,
        [accountId, g, date],
      );
      for (const b of beds) {
        await pool.query(
          'INSERT INTO amendment_log_beds (amendment_log_id, bed_id) VALUES ($1, $2)',
          [rows[0].id, b],
        );
      }
    };
    await amendment(`${S2}-03-01`, [bedA, bedB]);
    await amendment(`${S2}-04-01`, [bedA]);
    await amendment(`${S1}-04-01`, [bedC]);

    const tomato = await createPersonalSeed(accountId, 'Tomato');
    const bean = await createPersonalSeed(accountId, 'Bean');
    await harvest(g, { seedId: tomato }, `${S2}-07-01`, 320, 'g', { bedId: bedA });
    await harvest(g, { seedId: tomato }, `${S2}-07-11`, 160, 'g', { bedId: bedA });
    await harvest(g, { seedId: bean }, `${S2}-07-05`, 2, 'kg');
    // Last season: only entries without a bed.
    await harvest(g, { seedId: tomato }, `${S1}-07-01`, 100, 'g');

    const body = await dashboard(agent, { season: S2 });
    expect(body.isSupporter).toBe(true);
    expect(body.paid.soil).toEqual([
      {
        gardenId: String(g),
        gardenName: 'Plot',
        bedId: String(bedA),
        bedLabel: 'A',
        ph: 6.5,
        testDate: `${S2}-05-01`,
        status: 'balanced',
      },
      expect.objectContaining({ bedLabel: 'B', ph: 7.8, status: 'needs_attention' }),
      expect.objectContaining({ bedLabel: 'C', ph: null, status: 'no_ph' }),
    ]);
    expect(body.paid.amendments).toEqual({
      applicationCount: 2,
      bedCount: 2,
      seasonBedCount: 4,
      latest: {
        gardenId: String(g),
        gardenName: 'Plot',
        applicationDate: `${S2}-04-01`,
        productName: 'Compost',
        amendmentType: 'compost_manure',
        amount: null,
        amountUnit: null,
        beds: [{ bedId: String(bedA), label: 'A' }],
      },
      byType: [{ amendmentType: 'compost_manure', count: 2 }],
      // C was amended only last season.
      unamendedBeds: [
        { bedId: String(bedC), label: 'C', gardenId: String(g), gardenName: 'Plot' },
        { bedId: String(bedD), label: 'D', gardenId: String(g), gardenName: 'Plot' },
      ],
    });
    // S2 is a past season, so this week's weather is not fetched.
    expect(body.paid.weather).toEqual({
      station: null,
      locationLabel: 'Test City',
      units: 'imperial',
      week: null,
      insights: [],
      historyUnavailable: false,
    });
    expect(visualCrossing.fetchHistory).not.toHaveBeenCalled();

    const adv = body.paid.advanced;
    // 480 g over a 4x8 bed.
    expect(adv.yieldPerSqFt).toEqual([
      { seedId: String(tomato), cambiumSeedId: null, commonName: 'Tomato', perSqFt: 15, unit: 'g' },
    ]);
    expect(adv.yieldPerSqFtReason).toBeNull();
    expect(adv.topPerformer).toEqual({ commonName: 'Tomato', total: 480, unit: 'g', entryCount: 2 });
    expect(adv.frequency).toEqual([{ commonName: 'Tomato', avgDaysBetween: 10, entryCount: 2 }]);

    const last = await dashboard(agent, { season: S1 });
    expect(last.paid.advanced.yieldPerSqFt).toEqual([]);
    expect(last.paid.advanced.yieldPerSqFtReason).toBe('no_bed_data');

    // gardenId filters totals only: trend and the advanced metrics stay all-gardens.
    const emptyGarden = await createGarden(accountId, 'Empty');
    const filtered = await dashboard(agent, { season: S2, gardenId: emptyGarden });
    expect(filtered.totals).toEqual([]);
    expect(body.trend).toMatchObject({ state: 'ready', comparedSeason: S1 });
    expect(filtered.trend).toEqual(body.trend);
    expect(filtered.paid.advanced).toEqual(body.paid.advanced);
  });

  it('yieldPerSqFt counts each distinct bed area once', async () => {
    const { agent, accountId } = await account('paid-yield@example.com', 'supporter');
    const g = await createGarden(accountId);
    const big = await createBed(g, S2, 'Big', 4, 8); // 32 sq ft
    const small = await createBed(g, S2, 'Small', 2, 4); // 8 sq ft
    const squash = await createPersonalSeed(accountId, 'Squash');
    await harvest(g, { seedId: squash }, `${S2}-07-01`, 100, 'g', { bedId: big });
    await harvest(g, { seedId: squash }, `${S2}-07-08`, 60, 'g', { bedId: big });
    await harvest(g, { seedId: squash }, `${S2}-07-15`, 40, 'g', { bedId: small });

    const body = await dashboard(agent, { season: S2 });
    // 200 g over 32 + 8 = 40 sq ft (counting Big twice would give 200 / 72).
    expect(body.paid.advanced.yieldPerSqFt).toEqual([
      { seedId: String(squash), cambiumSeedId: null, commonName: 'Squash', perSqFt: 5, unit: 'g' },
    ]);
  });

  it('weather uses the primary connection', async () => {
    const { agent, accountId } = await account('paid-weather@example.com', 'supporter');
    await pool.query(
      `INSERT INTO weather_connections (account_id, provider, is_primary, last_successful_sync, created_at)
       VALUES ($1, 'pws_ambient', true, '2025-06-01T10:00:00Z', now() - interval '1 day'),
              ($1, 'public_weather', false, NULL, now())`,
      [accountId],
    );
    const body = await dashboard(agent, { season: NOW });
    expect(body.paid.weather).toEqual({
      station: { provider: 'pws_ambient', lastSuccessfulSync: '2025-06-01T10:00:00.000Z' },
      locationLabel: 'Test City',
      units: 'imperial',
      week: HISTORY_WEEK,
      insights: buildInsights(HISTORY),
      historyUnavailable: false,
    });
    expect(body.paid.weather.insights.length).toBeGreaterThan(0);
    expect(geocoder.geocode).toHaveBeenCalledWith('Test City');
    expect(visualCrossing.fetchHistory).toHaveBeenCalledWith(45.5, -122.7);
  });

  it('weather with no station still summarizes the location history', async () => {
    const { agent } = await account('paid-weather-nostation@example.com', 'supporter');
    const body = await dashboard(agent, { season: NOW });
    expect(body.paid.weather.station).toBeNull();
    expect(body.paid.weather.week).toEqual(HISTORY_WEEK);
    expect(body.paid.weather.historyUnavailable).toBe(false);
  });

  it('a past season skips the history fetch', async () => {
    const { agent } = await account('paid-weather-past@example.com', 'supporter');
    const body = await dashboard(agent, { season: NOW - 1 });
    expect(body.paid.weather).toMatchObject({
      locationLabel: 'Test City',
      week: null,
      insights: [],
      historyUnavailable: false,
    });
    expect(geocoder.geocode).not.toHaveBeenCalled();
    expect(visualCrossing.fetchHistory).not.toHaveBeenCalled();
  });

  it('weather with no location skips the history fetch', async () => {
    const { agent, accountId } = await account('paid-weather-noloc@example.com', 'supporter');
    await pool.query('UPDATE accounts SET zone_location_label = $1 WHERE id = $2', [
      LOCATION_NOT_SET,
      accountId,
    ]);
    const body = await dashboard(agent, { season: NOW });
    expect(body.paid.weather).toEqual({
      station: null,
      locationLabel: null,
      units: 'imperial',
      week: null,
      insights: [],
      historyUnavailable: false,
    });
    expect(geocoder.geocode).not.toHaveBeenCalled();
    expect(visualCrossing.fetchHistory).not.toHaveBeenCalled();
  });

  it('a failed Visual Crossing fetch marks history unavailable without failing the dashboard', async () => {
    const { agent } = await account('paid-weather-fail@example.com', 'supporter');
    vi.mocked(visualCrossing.fetchHistory).mockRejectedValueOnce(new Error('boom'));
    const body = await dashboard(agent, { season: NOW });
    expect(body.paid.weather).toMatchObject({
      locationLabel: 'Test City',
      week: null,
      insights: [],
      historyUnavailable: true,
    });
  });

  it('a failed geocode marks history unavailable without failing the dashboard', async () => {
    const { agent } = await account('paid-weather-geofail@example.com', 'supporter');
    vi.mocked(geocoder.geocode).mockRejectedValueOnce(new Error('no results'));
    const body = await dashboard(agent, { season: NOW });
    expect(body.paid.weather).toMatchObject({ week: null, insights: [], historyUnavailable: true });
    expect(visualCrossing.fetchHistory).not.toHaveBeenCalled();
  });

  it('a hanging Visual Crossing fetch times out without hanging the dashboard', async () => {
    const { agent } = await account('paid-weather-hang@example.com', 'supporter');
    vi.mocked(visualCrossing.fetchHistory).mockReturnValueOnce(new Promise(() => {}));
    const body = await dashboard(agent, { season: NOW });
    expect(body.paid.weather).toMatchObject({ week: null, insights: [], historyUnavailable: true });
  });

  it('a response with weather history unavailable is not cached', async () => {
    const { agent } = await account('paid-weather-nocache@example.com', 'supporter');
    vi.mocked(visualCrossing.fetchHistory).mockRejectedValueOnce(new Error('outage'));
    const first = await dashboard(agent, { season: NOW });
    expect(first.paid.weather.historyUnavailable).toBe(true);
    // No cache clear: the next read rebuilds and picks up the recovered fetch.
    const second = await dashboard(agent, { season: NOW });
    expect(second.paid.weather.historyUnavailable).toBe(false);
    expect(second.paid.weather.week).toEqual(HISTORY_WEEK);
  });

  it('weather units follow preferences.units', async () => {
    const { agent, accountId } = await account('paid-weather-units@example.com', 'supporter');
    await pool.query(`UPDATE accounts SET preferences = '{"units":"metric"}' WHERE id = $1`, [
      accountId,
    ]);
    const body = await dashboard(agent, { season: NOW });
    expect(body.paid.weather.units).toBe('metric');
  });

  it('PATCH /api/me/preferences and deleting a connection invalidate the cache', async () => {
    const { agent, accountId } = await account('paid-weather-cache@example.com', 'supporter');
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO weather_connections (account_id, provider, is_primary)
       VALUES ($1, 'pws_ambient', true) RETURNING id`,
      [accountId],
    );
    const before = await dashboard(agent, { season: S2 });
    expect(before.paid.weather.units).toBe('imperial');
    expect(before.paid.weather.station).toMatchObject({ provider: 'pws_ambient' });

    const patch = await agent.patch('/api/me/preferences').send({ units: 'metric' });
    expect(patch.status).toBe(200);
    expect((await dashboard(agent, { season: S2 })).paid.weather.units).toBe('metric');

    const del = await agent.delete(`/api/weather/connections/${rows[0].id}`);
    expect(del.status).toBe(204);
    expect((await dashboard(agent, { season: S2 })).paid.weather.station).toBeNull();
  });

  it('amendments: latest, byType order and unamended beds', async () => {
    const { agent, accountId } = await account('paid-amend@example.com', 'supporter');
    const g = await createGarden(accountId, 'Plot');
    const bedB = await createBed(g, S2, 'B');
    const bedA = await createBed(g, S2, 'A');
    const bedC = await createBed(g, S2, 'C');
    const bedD = await createBed(g, S2, 'D');

    const log = async (
      date: string,
      type: string,
      beds: number[],
      amount: number | null = null,
      unit: string | null = null,
    ) => {
      const { rows } = await pool.query<{ id: number }>(
        `INSERT INTO amendment_logs
           (user_id, garden_id, application_date, product_name, amendment_type, amount, amount_unit)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [accountId, g, date, `${type} product`, type, amount, unit],
      );
      for (const b of beds) {
        await pool.query(
          'INSERT INTO amendment_log_beds (amendment_log_id, bed_id) VALUES ($1, $2)',
          [rows[0].id, b],
        );
      }
    };
    await log(`${S2}-02-01`, 'mulch', [bedA]);
    await log(`${S2}-03-01`, 'lime', [bedA]);
    await log(`${S2}-05-01`, 'lime', [bedA]);
    await log(`${S2}-06-01`, 'mulch', [bedA]);
    // Same date as the mulch log but a higher id: this one is the latest.
    await log(`${S2}-06-01`, 'compost_manure', [bedB, bedA], 2.5, 'kg');
    // Last season only.
    await log(`${S1}-12-31`, 'other', [bedC]);

    const body = await dashboard(agent, { season: S2 });
    const am = body.paid.amendments;
    expect(am.applicationCount).toBe(5);
    expect(am.bedCount).toBe(2);
    expect(am.seasonBedCount).toBe(4);
    expect(am.latest).toEqual({
      gardenId: String(g),
      gardenName: 'Plot',
      applicationDate: `${S2}-06-01`,
      productName: 'compost_manure product',
      amendmentType: 'compost_manure',
      amount: 2.5,
      amountUnit: 'kg',
      beds: [
        { bedId: String(bedA), label: 'A' },
        { bedId: String(bedB), label: 'B' },
      ],
    });
    expect(am.byType).toEqual([
      { amendmentType: 'lime', count: 2 },
      { amendmentType: 'mulch', count: 2 },
      { amendmentType: 'compost_manure', count: 1 },
    ]);
    expect(am.unamendedBeds.map((b: { bedId: string }) => b.bedId)).toEqual([
      String(bedC),
      String(bedD),
    ]);

    const empty = await dashboard(agent, { season: 2023 });
    expect(empty.paid.amendments).toEqual({
      applicationCount: 0,
      bedCount: 0,
      seasonBedCount: 0,
      latest: null,
      byType: [],
      unamendedBeds: [],
    });
  });
});

// ── Cache ─────────────────────────────────────────────────────────────────────

describe('cache', () => {
  it('a new harvest is counted on the next read', async () => {
    const { agent, accountId } = await account('cache@example.com');
    const g = await createGarden(accountId);
    const seed = await createPersonalSeed(accountId, 'Pea');
    await harvest(g, { seedId: seed }, `${S2}-06-01`, 10, 'g');

    expect((await dashboard(agent, { season: S2 })).summary.harvestCount).toBe(1);

    const res = await agent
      .post('/api/harvests')
      .send({ gardenId: g, seedId: seed, harvestDate: `${S2}-06-02`, quantity: 5, unit: 'g' });
    expect(res.status).toBe(201);

    const body = await dashboard(agent, { season: S2 });
    expect(body.summary.harvestCount).toBe(2);
    expect(body.totals[0]).toMatchObject({ total: 15, unit: 'g' });
  });

  it('serves a cached body until a write invalidates it', async () => {
    const { agent, accountId } = await account('cache-hit@example.com');
    const g = await createGarden(accountId);
    const seed = await createPersonalSeed(accountId, 'Pea');
    await harvest(g, { seedId: seed }, `${S2}-06-01`, 10, 'g');
    expect((await dashboard(agent, { season: S2 })).summary.harvestCount).toBe(1);

    // A direct DB insert skips invalidation, so the cached body is served.
    await harvest(g, { seedId: seed }, `${S2}-06-02`, 10, 'g');
    expect((await dashboard(agent, { season: S2 })).summary.harvestCount).toBe(1);

    clearMetricsCache();
    expect((await dashboard(agent, { season: S2 })).summary.harvestCount).toBe(2);
  });

  it('a tier change is not served from the cache', async () => {
    const { agent, accountId } = await account('cache-tier@example.com');
    const free = await dashboard(agent, { season: S2 });
    expect(free.paid).toBeNull();

    await pool.query(`UPDATE accounts SET subscription_tier = 'supporter' WHERE id = $1`, [
      accountId,
    ]);
    const paid = await dashboard(agent, { season: S2 });
    expect(paid.isSupporter).toBe(true);
    expect(paid.paid).not.toBeNull();
  });
});

// ── Comparable plants and cross-season ────────────────────────────────────────

describe('comparable plants and cross-season', () => {
  let supporter: Agent;
  let tomato: number;
  let basil: number;
  let peaId: number;
  let gardenId: number;
  let otherGarden: number;
  let bedId: number;

  beforeAll(async () => {
    const a = await account('compare@example.com', 'supporter');
    supporter = a.agent;
    gardenId = await createGarden(a.accountId, 'Plot');
    otherGarden = await createGarden(a.accountId, 'Back');
    bedId = await createBed(gardenId, S2, 'Sunny');
    tomato = await createPersonalSeed(a.accountId, 'Tomato', { maturityMin: 60, maturityMax: 80 });
    basil = await createPersonalSeed(a.accountId, 'Basil');
    peaId = await createCambiumSeed('Pea', 'Pisum sativum');

    await harvest(gardenId, { seedId: tomato }, '2022-07-01', 1, 'kg');
    await harvest(gardenId, { seedId: tomato }, '2023-07-01', 2, 'kg');
    await harvest(gardenId, { seedId: tomato }, `${S1}-07-01`, 3, 'kg');
    await harvest(gardenId, { seedId: tomato }, `${S1}-07-21`, 1, 'kg', { notes: 'x'.repeat(100) });

    // 2025: sown 04-20, first harvest 06-19 (60 days); a second entry in a bed.
    const p = await plant(bedId, gardenId, S2, { seedId: tomato }, '2025-04-20');
    const ev = await sowingEvent(gardenId, { seedId: tomato }, S2, '2025-04-21', p);
    await harvest(gardenId, { seedId: tomato }, '2025-06-19', 2, 'kg', { sowingEventId: ev });
    await harvest(gardenId, { seedId: tomato }, '2025-06-29', 500, 'g', { bedId });
    await harvest(gardenId, { seedId: tomato }, '2025-07-09', 1.5, 'kg', { bedId });

    await harvest(gardenId, { seedId: basil }, `${S2}-07-01`, 50, 'g');
    await harvest(otherGarden, { cambiumSeedId: peaId }, `${S1}-05-01`, 100, 'g');
    await harvest(otherGarden, { cambiumSeedId: peaId }, `${S2}-05-01`, 120, 'g');
  });

  it('comparable-plants lists only plants with 2+ seasons', async () => {
    const res = await supporter.get('/api/metrics/comparable-plants');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      {
        seedId: null,
        cambiumSeedId: String(peaId),
        commonName: 'Pea',
        scientificName: 'Pisum sativum',
        seasons: [S2, S1],
      },
      {
        seedId: String(tomato),
        cambiumSeedId: null,
        commonName: 'Tomato',
        scientificName: null,
        seasons: [S2, S1, 2023, 2022],
      },
    ]);
  });

  it('comparable-plants is available to free accounts', async () => {
    const { agent } = await account('compare-free@example.com');
    const res = await agent.get('/api/metrics/comparable-plants');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('cross-season defaults to the two most recent seasons', async () => {
    const res = await supporter.get(`/api/metrics/cross-season?plant=seed:${tomato}`);
    expect(res.status).toBe(200);
    const body = res.body;
    expect(body.plant).toEqual({
      seedId: String(tomato),
      cambiumSeedId: null,
      commonName: 'Tomato',
      scientificName: null,
    });
    expect(body.availableSeasons).toEqual([S2, S1, 2023, 2022]);
    expect(body.unit).toBe('kg');
    expect(body.gardens).toHaveLength(2);
    expect(body.beds).toEqual([{ id: String(bedId), label: 'Sunny', gardenId: String(gardenId) }]);
    expect(body.seasons.map((s: { season: number }) => s.season)).toEqual([S1, S2]);

    const [s1, s2] = body.seasons;
    expect(s1).toMatchObject({
      total: 4,
      mixedUnits: false,
      entryCount: 2,
      firstDate: `${S1}-07-01`,
      lastDate: `${S1}-07-21`,
      avgDaysBetween: 20,
      sowing: null,
      predicted: { min: 60, max: 80 },
    });
    expect(s1.entries[1].notesExcerpt).toHaveLength(80);

    expect(s2).toMatchObject({
      total: 3.5,
      mixedUnits: true,
      entryCount: 3,
      avgDaysBetween: 10,
      sowing: { sowDate: '2025-04-20', sowDateSource: 'planting', daysToFirstHarvest: 60 },
    });
    expect(s2.entries[1]).toMatchObject({ quantity: 500, unit: 'g', bedLabel: 'Sunny' });
  });

  it('cross-season honours seasons and the bed filter', async () => {
    const res = await supporter.get(
      `/api/metrics/cross-season?plant=seed:${tomato}&seasons=2022,2025&gardenId=${gardenId}&bedId=${bedId}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.seasons.map((s: { season: number }) => s.season)).toEqual([2022, S2]);
    expect(res.body.seasons[0].entryCount).toBe(0);
    expect(res.body.seasons[1].entryCount).toBe(2);
  });

  it('cross-season rejects more than 4 seasons', async () => {
    const res = await supporter.get(
      `/api/metrics/cross-season?plant=seed:${tomato}&seasons=2021,2022,2023,2024,2025`,
    );
    expect(res.status).toBe(400);
  });

  it('cross-season is 404 for a one-season plant', async () => {
    const res = await supporter.get(`/api/metrics/cross-season?plant=seed:${basil}`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not enough seasons for this plant.' });
  });

  it('cross-season validates plant, garden and bed', async () => {
    expect((await supporter.get('/api/metrics/cross-season')).status).toBe(400);
    expect((await supporter.get('/api/metrics/cross-season?plant=tomato')).status).toBe(400);

    const stranger = await createUser('compare-stranger@example.com');
    const strangerGarden = await createGarden(stranger);
    expect(
      (
        await supporter.get(
          `/api/metrics/cross-season?plant=seed:${tomato}&gardenId=${strangerGarden}`,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await supporter.get(
          `/api/metrics/cross-season?plant=seed:${tomato}&gardenId=${otherGarden}&bedId=${bedId}`,
        )
      ).status,
    ).toBe(400);
  });

  it('ids beyond the Postgres INTEGER range are rejected, not a 500', async () => {
    const huge = '9999999999';
    const cs = (q: string) => supporter.get(`/api/metrics/cross-season?${q}`);
    const plantRes = await cs(`plant=seed:${huge}`);
    expect(plantRes.status).toBe(400);
    expect(plantRes.body.error).toMatch(/^plant must be/);
    expect((await cs(`plant=cambium:${huge}`)).status).toBe(400);
    expect((await cs(`plant=seed:${tomato}&bedId=${huge}`)).status).toBe(400);
    // isNumericId rejects ids past int4, so these are malformed rather than missing.
    expect((await cs(`plant=seed:${tomato}&gardenId=${huge}`)).status).toBe(400);
    expect((await supporter.get(`/api/metrics/dashboard?gardenId=${huge}`)).status).toBe(400);
  });
});

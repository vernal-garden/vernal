import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { Pool } from 'pg';
import app from '../index';
import { currentSeason } from '../lib/plantingSchedule';
import { db } from '../lib/db';
import { geocode } from '../lib/weather/geocode';
import { UpstreamError } from '../lib/weather/upstream';

// Frost station lookups geocode the garden label; isGeocodeMiss stays real.
vi.mock('../lib/weather/geocode', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/weather/geocode')>()),
  geocode: vi.fn(),
}));

// The error geocode throws when Nominatim has no answer (its message is what
// isGeocodeMiss checks).
const geocodeMiss = () => new UpstreamError('No geocoding results for the account location');

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL must be set to run tests');

const pool = new Pool({ connectionString: url });

const SEASON = currentSeason(new Date());

type Agent = ReturnType<typeof request.agent>;

async function resetDb() {
  await pool.query(
    'TRUNCATE accounts, guest_sessions, gardens, beds, plantings, seeds, sowing_events, user_seed_preferences RESTART IDENTITY CASCADE',
  );
  await pool.query('TRUNCATE cambium.seeds RESTART IDENTITY CASCADE');
}

async function createUser(email: string, password = 'Password123!'): Promise<number> {
  const hash = await bcrypt.hash(password, 4);
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO accounts (email, password_hash, zone, zone_location_label, email_verified)
     VALUES ($1, $2, '6b', 'Test City', true)
     RETURNING id`,
    [email, hash],
  );
  return rows[0].id;
}

async function loginAgent(email: string, password = 'Password123!'): Promise<Agent> {
  const agent = request.agent(app);
  await agent.post('/api/auth/guest');
  await agent.post('/api/auth/login').send({ email, password });
  return agent;
}

async function createGarden(agent: Agent, zone: string, zoneLocationLabel?: string): Promise<number> {
  const res = await agent
    .post('/api/gardens')
    .send({ name: `Garden ${zone}`, style: 'grid', zone, zoneLocationLabel, growingMethod: 'in_ground' });
  expect(res.status).toBe(201);
  return Number(res.body.id);
}

async function createBed(gardenId: number, season: number): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO beds (garden_id, season, type, label, grid_x, grid_y, grid_cols, grid_rows)
     VALUES ($1, $2, 'grid', 'Bed', 0, 0, 4, 4) RETURNING id`,
    [gardenId, season],
  );
  return rows[0].id;
}

async function plant(
  bedId: number,
  gardenId: number,
  season: number,
  seed: { seedId?: number; cambiumSeedId?: number },
  quantity = 1,
): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO plantings (bed_id, garden_id, season, seed_id, cambium_seed_id, quantity)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [bedId, gardenId, season, seed.seedId ?? null, seed.cambiumSeedId ?? null, quantity],
  );
  return rows[0].id;
}

interface GuideRowBody {
  commonName: string;
  seedId: string | null;
  cambiumSeedId: string | null;
  plantingCount: number;
  overrides: unknown;
  done: unknown;
  windows: Record<string, { start: string; end: string; source: string }>;
  missingReason: string | null;
}

function rowNamed(body: { rows: GuideRowBody[] }, name: string): GuideRowBody {
  return body.rows.find((r) => r.commonName === name)!;
}

let agentA: Agent;     // account with frost dates
let agentB: Agent;     // account without frost dates
let guest: Agent;
let gardenA: number;
let gardenB: number;
let guestGarden: number;
let tomatoSeedId: number;      // personal seed owned by A
let peaCambiumId: number;
let firstPeaPlantingId: number;

beforeAll(async () => {
  await resetDb();

  const accountA = await createUser('guide-a@example.com');
  await pool.query(
    `UPDATE accounts SET last_spring_frost_date = '2020-04-15', first_fall_frost_date = '2020-10-20'
     WHERE id = $1`,
    [accountA],
  );
  await createUser('guide-b@example.com');

  agentA = await loginAgent('guide-a@example.com');
  agentB = await loginAgent('guide-b@example.com');
  guest = request.agent(app);
  await guest.post('/api/auth/guest').expect(201);

  gardenA = await createGarden(agentA, '7b', 'Raleigh, NC');
  gardenB = await createGarden(agentB, '6b');
  guestGarden = await createGarden(guest, '6b');

  const { rows: seedRows } = await pool.query<{ id: number }>(
    `INSERT INTO seeds (owner_id, common_name, scientific_name, plant_family, origin,
                        weeks_to_transplant, frost_tolerance, maturity_days_min, maturity_days_max)
     VALUES ($1, 'Tomato', 'Solanum lycopersicum', 'Solanaceae', 'user_created', 6, 'none', 60, 80)
     RETURNING id`,
    [accountA],
  );
  tomatoSeedId = seedRows[0].id;

  const { rows: peaRows } = await pool.query<{ id: number }>(
    `INSERT INTO cambium.seeds (common_name, scientific_name, plant_family, source,
                                frost_tolerance, maturity_days_min, maturity_days_max)
     VALUES ('Pea', 'Pisum sativum', 'Fabaceae', 'editorial', 'hard', 55, 70)
     RETURNING id`,
  );
  peaCambiumId = peaRows[0].id;
  // In the catalogue but never planted — must not produce a row.
  await pool.query(
    `INSERT INTO cambium.seeds (common_name, source) VALUES ('Unplanted Kale', 'editorial')`,
  );

  const bedA = await createBed(gardenA, SEASON);
  await plant(bedA, gardenA, SEASON, { seedId: tomatoSeedId }, 2);
  await plant(bedA, gardenA, SEASON, { seedId: tomatoSeedId }, 3);
  firstPeaPlantingId = await plant(bedA, gardenA, SEASON, { cambiumSeedId: peaCambiumId });
  await plant(bedA, gardenA, SEASON, { cambiumSeedId: peaCambiumId });
  // Last season's planting — excluded from this season's guide.
  const oldBed = await createBed(gardenA, SEASON - 1);
  await plant(oldBed, gardenA, SEASON - 1, { seedId: tomatoSeedId });

  await plant(await createBed(gardenB, SEASON), gardenB, SEASON, { cambiumSeedId: peaCambiumId });
  await plant(await createBed(guestGarden, SEASON), guestGarden, SEASON, { cambiumSeedId: peaCambiumId });
});

// No test reaches the network: an unmocked lookup finds nothing.
beforeEach(() => {
  vi.mocked(geocode).mockReset().mockRejectedValue(geocodeMiss());
});

afterAll(() => pool.end());

describe('GET /api/planting-guide', () => {
  it('returns rows for planted seeds only, using the account frost dates', async () => {
    const res = await agentA.get('/api/planting-guide');
    expect(res.status).toBe(200);
    expect(res.body.season).toBe(SEASON);
    expect(res.body.currentSeason).toBe(SEASON);
    expect(res.body.readOnly).toBe(false);
    expect(res.body.gardens).toEqual([
      {
        id: String(gardenA),
        name: 'Garden 7b',
        zone: '7b',
        zoneLocationLabel: 'Raleigh, NC',
        frost: {
          lastSpringFrost: `${SEASON}-04-15`,
          firstFallFrost: `${SEASON}-10-20`,
          frostSource: 'account_frost',
          frostFree: false,
          frostBasis: null,
          stationName: null,
        },
      },
    ]);
    expect(res.body.rows.map((r: { commonName: string }) => r.commonName)).toEqual(['Pea', 'Tomato']);

    const tomato = rowNamed(res.body, 'Tomato');
    expect(tomato.seedId).toBe(String(tomatoSeedId));
    expect(tomato.cambiumSeedId).toBeNull();
    expect(tomato.windows.transplant).toEqual({
      start: `${SEASON}-04-22`,
      end: `${SEASON}-05-06`,
      source: 'account_frost',
    });
    expect(tomato.windows.directSow).toBeNull();
    expect(tomato.missingReason).toBeNull();
    expect(tomato.overrides).toBeNull();
    expect(tomato.done).toBeNull();
  });

  it('includes the timing fields on each row', async () => {
    const res = await agentA.get('/api/planting-guide');
    const tomato = rowNamed(res.body, 'Tomato') as unknown as Record<string, unknown>;
    expect(tomato.frostTolerance).toBe('none');
    expect(tomato.weeksToTransplant).toBe(6);
    expect(tomato.maturityDaysMin).toBe(60);
    expect(tomato.maturityDaysMax).toBe(80);
    const pea = rowNamed(res.body, 'Pea') as unknown as Record<string, unknown>;
    expect(pea.frostTolerance).toBe('hard');
    expect(pea.weeksToTransplant).toBeNull();
    expect(pea.maturityDaysMin).toBe(55);
    expect(pea.maturityDaysMax).toBe(70);
  });

  it('returns a null zoneLocationLabel when the garden has none', async () => {
    const res = await agentB.get('/api/planting-guide');
    expect(res.body.gardens[0].zoneLocationLabel).toBeNull();
  });

  it('normalizes an unknown stored frost tolerance to none', async () => {
    // A future season keeps this planting out of the other tests' rows.
    const future = SEASON + 1;
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO cambium.seeds (common_name, source, frost_tolerance)
       VALUES ('Mystery Squash', 'editorial', 'moderate') RETURNING id`,
    );
    await plant(await createBed(gardenB, future), gardenB, future, { cambiumSeedId: rows[0].id });
    const res = await agentB.get(`/api/planting-guide?season=${future}`);
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].frostTolerance).toBe('none');
  });

  it('collapses two plantings of the same seed into one row with summed quantity', async () => {
    const res = await agentA.get('/api/planting-guide');
    const tomatoRows = res.body.rows.filter((r: { commonName: string }) => r.commonName === 'Tomato');
    expect(tomatoRows).toHaveLength(1);
    expect(tomatoRows[0].plantingCount).toBe(5);
    expect(rowNamed(res.body, 'Pea').plantingCount).toBe(2);
  });

  it('marks past seasons read-only', async () => {
    const res = await agentA.get(`/api/planting-guide?season=${SEASON - 1}`);
    expect(res.status).toBe(200);
    expect(res.body.readOnly).toBe(true);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.gardens[0].frost.lastSpringFrost).toBe(`${SEASON - 1}-04-15`);
  });

  it('falls back to the garden zone estimate when the account has no frost dates', async () => {
    const res = await agentB.get('/api/planting-guide');
    expect(res.status).toBe(200);
    expect(res.body.gardens[0].frost).toEqual({
      lastSpringFrost: `${SEASON}-04-24`,
      firstFallFrost: `${SEASON}-10-24`,
      frostSource: 'zone_estimate',
      frostFree: false,
      frostBasis: 'noaa',
      stationName: null,
    });
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].windows.directSow).toEqual({
      start: `${SEASON}-03-13`,
      end: `${SEASON}-04-10`,
      source: 'zone_estimate',
    });
  });

  it("returns 404 for another account's gardenId", async () => {
    const res = await agentA.get(`/api/planting-guide?gardenId=${gardenB}`);
    expect(res.status).toBe(404);
  });

  it('filters to one garden when gardenId is owned', async () => {
    const res = await agentA.get(`/api/planting-guide?gardenId=${gardenA}`);
    expect(res.status).toBe(200);
    expect(res.body.gardens).toHaveLength(1);
  });

  it('rejects a non-numeric gardenId and a bad season', async () => {
    expect((await agentA.get('/api/planting-guide?gardenId=abc')).status).toBe(400);
    expect((await agentA.get('/api/planting-guide?season=next')).status).toBe(400);
  });

  it('requires a session', async () => {
    expect((await request(app).get('/api/planting-guide')).status).toBe(401);
  });
});

describe('GET /api/planting-guide frost stations', () => {
  const SPOKANE = { lat: 47.62, lon: -117.53 };
  const ZONE_6B_FROST = {
    lastSpringFrost: `${SEASON}-04-24`,
    firstFallFrost: `${SEASON}-10-24`,
    frostSource: 'zone_estimate',
    frostFree: false,
    frostBasis: 'noaa',
    stationName: null,
  };

  let accountCount = 0;
  async function freshAgent(): Promise<Agent> {
    const email = `guide-station-${++accountCount}@example.com`;
    await createUser(email);
    return loginAgent(email);
  }

  async function storedStation(gardenId: number) {
    const { rows } = await pool.query<{ frost_station_id: string | null; frost_station_label: string | null }>(
      'SELECT frost_station_id, frost_station_label FROM gardens WHERE id = $1',
      [gardenId],
    );
    return rows[0];
  }

  it('dates a garden near Spokane from its station and stores the station', async () => {
    vi.mocked(geocode).mockResolvedValue(SPOKANE);
    const agent = await freshAgent();
    const gardenId = await createGarden(agent, '6b', 'Spokane, WA');

    const res = await agent.get('/api/planting-guide');
    expect(res.status).toBe(200);
    expect(res.body.gardens[0].frost).toEqual({
      lastSpringFrost: `${SEASON}-04-26`,
      firstFallFrost: `${SEASON}-10-24`,
      frostSource: 'zone_estimate',
      frostFree: false,
      frostBasis: 'station',
      stationName: 'Spokane Intl Airport',
    });
    expect(geocode).toHaveBeenCalledWith('Spokane, WA');
    expect(await storedStation(gardenId)).toEqual({
      frost_station_id: 'USW00024157',
      frost_station_label: 'Spokane, WA',
    });
  });

  it('does not look the station up again on a second load', async () => {
    vi.mocked(geocode).mockResolvedValue(SPOKANE);
    const agent = await freshAgent();
    await createGarden(agent, '6b', 'Spokane, WA');

    await agent.get('/api/planting-guide');
    const res = await agent.get('/api/planting-guide');
    expect(res.body.gardens[0].frost.stationName).toBe('Spokane Intl Airport');
    expect(geocode).toHaveBeenCalledTimes(1);
  });

  it('looks the station up again after the garden label changes', async () => {
    vi.mocked(geocode).mockResolvedValue(SPOKANE);
    const agent = await freshAgent();
    const gardenId = await createGarden(agent, '6b', 'Spokane, WA');
    await agent.get('/api/planting-guide');

    await pool.query(`UPDATE gardens SET zone_location_label = 'Cheney, WA' WHERE id = $1`, [gardenId]);
    const res = await agent.get('/api/planting-guide');
    expect(geocode).toHaveBeenCalledTimes(2);
    expect(geocode).toHaveBeenLastCalledWith('Cheney, WA');
    expect(res.body.gardens[0].frost.stationName).toBe('Spokane Intl Airport');
    expect((await storedStation(gardenId)).frost_station_label).toBe('Cheney, WA');
  });

  it('stores the label with no station on a geocode miss, and does not retry it', async () => {
    const agent = await freshAgent();
    const gardenId = await createGarden(agent, '6b', 'Nowhere In Particular');

    const res = await agent.get('/api/planting-guide');
    expect(res.status).toBe(200);
    expect(res.body.gardens[0].frost).toEqual(ZONE_6B_FROST);
    expect(await storedStation(gardenId)).toEqual({
      frost_station_id: null,
      frost_station_label: 'Nowhere In Particular',
    });

    await agent.get('/api/planting-guide');
    expect(geocode).toHaveBeenCalledTimes(1);
  });

  it('stores nothing on a network failure, and retries on the next load', async () => {
    vi.mocked(geocode).mockRejectedValue(new UpstreamError('Nominatim unreachable'));
    const agent = await freshAgent();
    const gardenId = await createGarden(agent, '6b', 'Spokane, WA');

    const res = await agent.get('/api/planting-guide');
    expect(res.status).toBe(200);
    expect(res.body.gardens[0].frost).toEqual(ZONE_6B_FROST);
    expect(await storedStation(gardenId)).toEqual({ frost_station_id: null, frost_station_label: null });

    await agent.get('/api/planting-guide');
    expect(geocode).toHaveBeenCalledTimes(2);
  });

  it('stops looking stations up for the request after a network failure', async () => {
    vi.mocked(geocode).mockRejectedValue(new UpstreamError('Nominatim unreachable'));
    const agent = await freshAgent();
    const first = await createGarden(agent, '6b', 'Spokane, WA');
    const second = await createGarden(agent, '6b', 'Cheney, WA');

    const res = await agent.get('/api/planting-guide');
    expect(res.status).toBe(200);
    expect(geocode).toHaveBeenCalledTimes(1);
    expect(res.body.gardens.map((g: { frost: unknown }) => g.frost)).toEqual([ZONE_6B_FROST, ZONE_6B_FROST]);
    for (const gardenId of [first, second]) {
      expect(await storedStation(gardenId)).toEqual({ frost_station_id: null, frost_station_label: null });
    }
  });

  it('keeps the zone estimate when storing the station fails', async () => {
    vi.mocked(geocode).mockResolvedValue(SPOKANE);
    const agent = await freshAgent();
    const gardenId = await createGarden(agent, '6b', 'Spokane, WA');
    const realQuery = db.query.bind(db) as (...args: unknown[]) => Promise<unknown>;
    const spy = vi.spyOn(db, 'query').mockImplementation(((...args: unknown[]) =>
      typeof args[0] === 'string' && args[0].includes('SET frost_station_id')
        ? Promise.reject(new Error('write failed'))
        : realQuery(...args)) as typeof db.query);
    try {
      const res = await agent.get('/api/planting-guide');
      expect(res.status).toBe(200);
      expect(res.body.gardens[0].frost).toEqual(ZONE_6B_FROST);
    } finally {
      spy.mockRestore();
    }
    expect(await storedStation(gardenId)).toEqual({ frost_station_id: null, frost_station_label: null });
  });

  it('makes no lookups when the account has its own frost date', async () => {
    vi.mocked(geocode).mockResolvedValue(SPOKANE);
    const email = 'guide-station-own-date@example.com';
    const accountId = await createUser(email);
    await pool.query(`UPDATE accounts SET last_spring_frost_date = '2020-04-15' WHERE id = $1`, [accountId]);
    const agent = await loginAgent(email);
    const gardenId = await createGarden(agent, '6b', 'Spokane, WA');

    const res = await agent.get('/api/planting-guide');
    expect(res.body.gardens[0].frost.frostSource).toBe('account_frost');
    expect(res.body.gardens[0].frost.stationName).toBeNull();
    expect(geocode).not.toHaveBeenCalled();
    expect((await storedStation(gardenId)).frost_station_label).toBeNull();
  });

  it('makes no lookup for a blank or unset label', async () => {
    const agent = await freshAgent();
    const gardenId = await createGarden(agent, '6b', 'Somewhere');
    await pool.query(`UPDATE gardens SET zone_location_label = '   ' WHERE id = $1`, [gardenId]);
    await agent.get('/api/planting-guide');
    await pool.query(`UPDATE gardens SET zone_location_label = 'Not set' WHERE id = $1`, [gardenId]);
    await agent.get('/api/planting-guide');
    expect(geocode).not.toHaveBeenCalled();
  });

  it('reports a garden near Borrego Desert Park as frost-free from its station', async () => {
    vi.mocked(geocode).mockResolvedValue({ lat: 33.26, lon: -116.4 });
    const agent = await freshAgent();
    await createGarden(agent, '9b', 'Borrego Springs, CA');

    const res = await agent.get('/api/planting-guide');
    expect(res.body.gardens[0].frost).toEqual({
      lastSpringFrost: null,
      firstFallFrost: null,
      frostSource: null,
      frostFree: true,
      frostBasis: 'station',
      stationName: 'Borrego Desert Park',
    });
  });

  it('looks up at most three gardens per request', async () => {
    vi.mocked(geocode).mockResolvedValue(SPOKANE);
    const agent = await freshAgent();
    for (const label of ['Spokane, WA', 'Cheney, WA', 'Airway Heights, WA', 'Medical Lake, WA']) {
      await createGarden(agent, '6b', label);
    }

    const first = await agent.get('/api/planting-guide');
    expect(geocode).toHaveBeenCalledTimes(3);
    expect(first.body.gardens.map((g: { frost: { stationName: string | null } }) => g.frost.stationName)).toEqual([
      'Spokane Intl Airport',
      'Spokane Intl Airport',
      'Spokane Intl Airport',
      null,
    ]);

    const second = await agent.get('/api/planting-guide');
    expect(geocode).toHaveBeenCalledTimes(4);
    expect(geocode).toHaveBeenLastCalledWith('Medical Lake, WA');
    expect(second.body.gardens[3].frost.stationName).toBe('Spokane Intl Airport');
  });
});

describe('guest access', () => {
  it('can read the guide', async () => {
    const res = await guest.get('/api/planting-guide');
    expect(res.status).toBe(200);
    expect(res.body.gardens.map((g: { id: string }) => g.id)).toEqual([String(guestGarden)]);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].overrides).toBeNull();
  });

  it('cannot set overrides', async () => {
    const res = await guest
      .put('/api/planting-guide/overrides')
      .send({ gardenId: guestGarden, cambiumSeedId: peaCambiumId, directSow: `${SEASON}-03-01` });
    expect(res.status).toBe(401);
  });

  it('can mark a seed done', async () => {
    const res = await guest
      .put('/api/planting-guide/done')
      .send({ gardenId: guestGarden, cambiumSeedId: peaCambiumId, season: SEASON, done: true });
    expect(res.status).toBe(200);
    expect(res.body.sowingEventId).toEqual(expect.any(String));
    expect(res.body.markedDoneAt).not.toBeNull();
  });
});

describe('PUT /api/planting-guide/overrides', () => {
  it('sets a transplant date that the guide then shows as a custom window', async () => {
    const put = await agentA
      .put('/api/planting-guide/overrides')
      .send({ gardenId: gardenA, seedId: tomatoSeedId, transplant: '2026-05-10' });
    expect(put.status).toBe(200);
    expect(put.body.overrides).toEqual({ indoorStart: null, transplant: '2026-05-10', directSow: null });

    const res = await agentA.get('/api/planting-guide');
    const tomato = rowNamed(res.body, 'Tomato');
    expect(tomato.overrides).toEqual({ indoorStart: null, transplant: '2026-05-10', directSow: null });
    expect(tomato.windows.transplant).toEqual({
      start: `${SEASON}-05-10`,
      end: `${SEASON}-05-10`,
      source: 'custom',
    });
    expect(tomato.windows.harvest.source).toBe('custom');
  });

  it('leaves absent fields unchanged', async () => {
    const put = await agentA
      .put('/api/planting-guide/overrides')
      .send({ gardenId: gardenA, seedId: tomatoSeedId, indoorStart: '2026-03-01' });
    expect(put.status).toBe(200);
    expect(put.body.overrides).toEqual({
      indoorStart: '2026-03-01',
      transplant: '2026-05-10',
      directSow: null,
    });
  });

  it('deletes the row once all three dates are null', async () => {
    const put = await agentA.put('/api/planting-guide/overrides').send({
      gardenId: gardenA,
      seedId: tomatoSeedId,
      indoorStart: null,
      transplant: null,
      directSow: null,
    });
    expect(put.status).toBe(200);
    expect(put.body.overrides).toBeNull();

    const { rows } = await pool.query('SELECT id FROM user_seed_preferences');
    expect(rows).toHaveLength(0);

    const res = await agentA.get('/api/planting-guide');
    expect(rowNamed(res.body, 'Tomato').overrides).toBeNull();
  });

  it("returns 404 for another account's garden", async () => {
    const res = await agentA
      .put('/api/planting-guide/overrides')
      .send({ gardenId: gardenB, cambiumSeedId: peaCambiumId, directSow: '2026-03-01' });
    expect(res.status).toBe(404);
  });

  it('rejects bad dates and seed keys', async () => {
    const send = (body: object) => agentA.put('/api/planting-guide/overrides').send(body);
    expect((await send({ gardenId: gardenA, seedId: tomatoSeedId, transplant: '2026-02-30' })).status).toBe(400);
    expect((await send({ gardenId: gardenA, seedId: tomatoSeedId, transplant: 'May 10' })).status).toBe(400);
    expect(
      (await send({ gardenId: gardenA, seedId: tomatoSeedId, cambiumSeedId: peaCambiumId })).status,
    ).toBe(400);
    expect((await send({ gardenId: gardenA })).status).toBe(400);
  });
});

describe('PUT /api/planting-guide/done', () => {
  const body = (done: boolean) => ({
    gardenId: gardenA,
    cambiumSeedId: peaCambiumId,
    season: SEASON,
    done,
  });

  it('marks, unmarks and re-marks the same sowing event', async () => {
    const first = await agentA.put('/api/planting-guide/done').send(body(true));
    expect(first.status).toBe(200);
    expect(first.body.markedDoneAt).not.toBeNull();
    const eventId = first.body.sowingEventId;

    const { rows } = await pool.query<{ planting_id: number }>(
      'SELECT planting_id FROM sowing_events WHERE id = $1',
      [eventId],
    );
    expect(rows[0].planting_id).toBe(firstPeaPlantingId);

    const undo = await agentA.put('/api/planting-guide/done').send(body(false));
    expect(undo.status).toBe(200);
    expect(undo.body).toEqual({ sowingEventId: eventId, markedDoneAt: null });
    const { rows: still } = await pool.query('SELECT id FROM sowing_events WHERE id = $1', [eventId]);
    expect(still).toHaveLength(1);

    const guide = await agentA.get('/api/planting-guide');
    expect(rowNamed(guide.body, 'Pea').done).toEqual({ sowingEventId: eventId, markedDoneAt: null });

    const again = await agentA.put('/api/planting-guide/done').send(body(true));
    expect(again.status).toBe(200);
    expect(again.body.sowingEventId).toBe(eventId);
    expect(again.body.markedDoneAt).not.toBeNull();
  });

  it('returns 409 for a past season', async () => {
    const res = await agentA
      .put('/api/planting-guide/done')
      .send({ ...body(true), season: SEASON - 1 });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Past seasons are read-only.' });
  });

  it('rejects both seed keys or a missing done flag', async () => {
    const both = await agentA
      .put('/api/planting-guide/done')
      .send({ ...body(true), seedId: tomatoSeedId });
    expect(both.status).toBe(400);

    const missing = await agentA.put('/api/planting-guide/done').send({
      gardenId: gardenA,
      cambiumSeedId: peaCambiumId,
      season: SEASON,
    });
    expect(missing.status).toBe(400);
  });

  it("returns 404 for another account's garden", async () => {
    const res = await agentB.put('/api/planting-guide/done').send(body(true));
    expect(res.status).toBe(404);
  });
});

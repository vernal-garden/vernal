import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { Pool } from 'pg';
import sharp from 'sharp';

vi.mock('../lib/storage/s3', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/storage/s3')>()),
  uploadToR2: vi.fn(async () => undefined),
  deleteFromR2: vi.fn(async () => {}),
}));

vi.mock('../lib/r2Cleanup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/r2Cleanup')>()),
  drainSoon: vi.fn(),
}));

import app from '../index';
import { db } from '../lib/db';
import { logger } from '../lib/logger';
import { BETA_TERMS_VERSION } from '../lib/legal';
import { invalidateBetaSettings } from '../lib/beta';
import { getServerConfig, setServerConfigForTests } from '../lib/serverConfig';
import { currentSeason } from '../lib/season';
import {
  isCountedWrite,
  pacificWeekStart,
  setBetaActivityClockForTests,
  resetBetaActivityForTests,
  betaActivitySettledForTests,
} from './betaActivity';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL must be set to run tests');

const pool = new Pool({ connectionString: url });
const PASSWORD = 'Password123!';
const GARDEN = { name: 'Plot', style: 'grid', zone: '7b', growingMethod: 'in_ground' };

type Agent = ReturnType<typeof request.agent>;

async function resetDb() {
  await pool.query(
    `TRUNCATE accounts, guest_sessions, gardens, beds, plantings, seeds, seed_photos, sowing_events,
              harvest_entries, soil_readings, user_seed_preferences, feedback_submissions,
              weather_connections, r2_deletions, beta_active_weeks RESTART IDENTITY CASCADE`,
  );
}

async function createUser(email: string, participant: boolean): Promise<number> {
  const hash = await bcrypt.hash(PASSWORD, 4);
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO accounts
       (email, password_hash, zone, zone_location_label, email_verified,
        beta_participant_at, beta_terms_version, beta_terms_accepted_at)
     VALUES ($1, $2, '7b', 'Test City', true, $3, $4, $3)
     RETURNING id`,
    [email, hash, participant ? new Date() : null, participant ? BETA_TERMS_VERSION : null],
  );
  return rows[0].id;
}

async function loginAgent(email: string): Promise<Agent> {
  const agent = request.agent(app);
  await agent.post('/api/auth/guest');
  const res = await agent.post('/api/auth/login').send({ email, password: PASSWORD });
  expect(res.status).toBe(200);
  return agent;
}

// Forgets everything recorded so far, so the next write starts from nothing.
async function clearWeeks() {
  await betaActivitySettledForTests();
  await pool.query('TRUNCATE beta_active_weeks');
  resetBetaActivityForTests();
}

async function weeks(accountId: number) {
  await betaActivitySettledForTests();
  const { rows } = await pool.query<{ week_start: string; first_active_at: Date }>(
    `SELECT week_start::text, first_active_at FROM beta_active_weeks
     WHERE account_id = $1 ORDER BY week_start`,
    [accountId],
  );
  return rows;
}

async function allWeeks() {
  await betaActivitySettledForTests();
  const { rows } = await pool.query('SELECT * FROM beta_active_weeks');
  return rows;
}

async function createGarden(agent: Agent): Promise<string> {
  const res = await agent.post('/api/gardens').send(GARDEN);
  expect(res.status).toBe(201);
  return String(res.body.id);
}

async function createBed(agent: Agent, gardenId: string): Promise<string> {
  const res = await agent
    .post(`/api/gardens/${gardenId}/beds`)
    .send({ type: 'grid', label: 'Bed', grid: { x: 0, y: 0, cols: 4, rows: 4 } });
  expect(res.status).toBe(201);
  return String(res.body.id);
}

async function createSeed(agent: Agent, name = 'Tomato'): Promise<string> {
  const res = await agent.post('/api/seeds').send({ commonName: name, plantFamily: 'Fam' });
  expect(res.status).toBe(201);
  return String(res.body.id);
}

// One account's whole fixture: a garden, a bed, a seed and a planting.
interface Fixture {
  accountId: number;
  agent: Agent;
  gardenId: string;
  bedId: string;
  seedId: string;
  plantingId: string;
}

async function fixture(email: string, participant: boolean): Promise<Fixture> {
  const accountId = await createUser(email, participant);
  const agent = await loginAgent(email);
  const gardenId = await createGarden(agent);
  const bedId = await createBed(agent, gardenId);
  const seedId = await createSeed(agent);
  const planting = await agent
    .post(`/api/gardens/${gardenId}/beds/${bedId}/plantings`)
    .send({ seedId: Number(seedId), cell: { x: 0, y: 0 } });
  expect(planting.status).toBe(201);
  return { accountId, agent, gardenId, bedId, seedId, plantingId: String(planting.body.id) };
}

async function insertPhoto(seedId: string): Promise<string> {
  const key = `seed-photos/${seedId}/11111111-1111-4111-8111-111111111111.jpg`;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO seed_photos (seed_id, storage_url, r2_key) VALUES ($1, $2, $2) RETURNING id::text`,
    [seedId, key],
  );
  return rows[0].id;
}

async function insertSoilReading(f: Fixture): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO soil_readings (user_id, garden_id, bed_id, test_date, ph)
     VALUES ($1, $2, $3, '2026-06-01', 6.4) RETURNING id::text`,
    [f.accountId, f.gardenId, f.bedId],
  );
  return rows[0].id;
}

async function setSupporterAccess(on: boolean) {
  await pool.query('UPDATE beta_settings SET supporter_access_on = $1 WHERE id = 1', [on]);
  invalidateBetaSettings();
}

let png: Buffer;
let originalConfig: ReturnType<typeof getServerConfig>;

beforeAll(async () => {
  png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#4a7' } }).png().toBuffer();
  await pool.query(
    `UPDATE beta_settings SET gate_on = false, guest_mode_on = true,
       supporter_access_on = true, gate_first_on_at = NULL WHERE id = 1`,
  );
  invalidateBetaSettings();
  originalConfig = getServerConfig();
});

beforeEach(async () => {
  await betaActivitySettledForTests();
  await resetDb();
  resetBetaActivityForTests();
  // Real-clock tests must not depend on the default BETA_ENDS_AT having not passed.
  setServerConfigForTests({ ...originalConfig, betaEndsAt: new Date('2100-01-01T00:00:00Z') });
});

afterEach(() => {
  setBetaActivityClockForTests(null);
  setServerConfigForTests(originalConfig);
  vi.restoreAllMocks();
});

afterAll(async () => {
  await betaActivitySettledForTests();
  await pool.end();
});

describe('pacificWeekStart', () => {
  it.each([
    // Sunday night and Monday morning, Pacific (PST, UTC-8).
    ['2026-12-07T07:59:00Z', '2026-11-30'],
    ['2026-12-07T08:01:00Z', '2026-12-07'],
    // Across the DST change: 2026-11-01 01:30 PDT, 2026-11-01 23:30 PST, 2026-11-02 00:30 PST.
    ['2026-11-01T08:30:00Z', '2026-10-26'],
    ['2026-11-02T07:30:00Z', '2026-10-26'],
    ['2026-11-02T08:30:00Z', '2026-11-02'],
    // Into DST: Sunday 2026-03-08 23:30 PDT, Monday 2026-03-09 00:30 PDT.
    ['2026-03-09T06:30:00Z', '2026-03-02'],
    ['2026-03-09T07:30:00Z', '2026-03-09'],
    // A Monday at midday, and New Year's week spanning two years.
    ['2026-11-09T20:00:00Z', '2026-11-09'],
    ['2027-01-01T20:00:00Z', '2026-12-28'],
  ])('%s → week of %s, as Postgres computes it', async (at, expected) => {
    expect(pacificWeekStart(new Date(at))).toBe(expected);
    const { rows } = await pool.query<{ d: string }>(
      `SELECT date_trunc('week', $1::timestamptz AT TIME ZONE 'America/Los_Angeles')::date::text AS d`,
      [at],
    );
    expect(rows[0].d).toBe(expected);
  });
});

describe('isCountedWrite', () => {
  it.each([
    ['POST', '/api/gardens'],
    ['PATCH', '/api/gardens/1'],
    ['PATCH', '/api/gardens/1/beds/2'],
    ['DELETE', '/api/plantings/3'],
    ['POST', '/api/soil-readings'],
    ['DELETE', '/api/amendments/4'],
    ['POST', '/api/seeds'],
    ['DELETE', '/api/seeds/5/photos/6'],
    ['POST', '/api/harvests'],
    ['PUT', '/api/planting-guide/done'],
    ['PUT', '/api/planting-guide/overrides'],
    // Only the listed method+path pairs are excluded.
    ['PATCH', '/api/gardens/1/thumbnail'],
    ['POST', '/api/gardens/1/plantings/displayed-stage'],
    ['DELETE', '/api/seeds/5/contribute'],
  ])('%s %s counts', (method, path) => {
    expect(isCountedWrite(method, path)).toBe(true);
  });

  it.each([
    ['GET', '/api/gardens'],
    ['HEAD', '/api/gardens'],
    ['OPTIONS', '/api/gardens'],
    ['POST', '/api/gardens/1/thumbnail'],
    ['PATCH', '/api/gardens/1/plantings/displayed-stage'],
    ['POST', '/api/seeds/5/contribute'],
    ['POST', '/api/seedsx'],
    ['POST', '/api/gardensx/1'],
    ['PUT', '/api/planting-guide'],
    ['PUT', '/api/planting-guide/done/x'],
    ['POST', '/api/feedback'],
    ['POST', '/api/micro-feedback'],
    ['PATCH', '/api/me'],
    ['DELETE', '/api/weather/connections/1'],
    ['POST', '/api/events/batch'],
  ])('%s %s does not count', (method, path) => {
    expect(isCountedWrite(method, path)).toBe(false);
  });

  it('matches an excluded <id> as exactly one segment', () => {
    expect(isCountedWrite('POST', '/api/gardens/1/2/thumbnail')).toBe(true);
    expect(isCountedWrite('POST', '/api/seeds/a/b/contribute')).toBe(true);
  });
});

describe('active weeks through the app', () => {
  it("records a participant's POST /api/gardens once for this week", async () => {
    const accountId = await createUser('p@example.com', true);
    const agent = await loginAgent('p@example.com');
    const querySpy = vi.spyOn(db, 'query');

    await createGarden(agent);
    const rows = await weeks(accountId);
    expect(rows).toHaveLength(1);
    const { rows: pg } = await pool.query<{ d: string }>(
      `SELECT date_trunc('week', now() AT TIME ZONE 'America/Los_Angeles')::date::text AS d`,
    );
    expect(rows[0].week_start).toBe(pg[0].d);

    await createGarden(agent);
    expect(await weeks(accountId)).toHaveLength(1);
    // The second write was skipped in process, without a query.
    const inserts = querySpy.mock.calls.filter(([sql]) => String(sql).includes('beta_active_weeks'));
    expect(inserts).toHaveLength(1);
  });

  it('records each counted family', async () => {
    const f = await fixture('p@example.com', true);
    const photoId = await insertPhoto(f.seedId);
    const readingId = await insertSoilReading(f);
    const season = currentSeason();

    const writes: Array<[string, () => Promise<request.Response>]> = [
      [
        'a bed edit',
        () => f.agent.patch(`/api/gardens/${f.gardenId}/beds/${f.bedId}`).send({ label: 'Renamed' }),
      ],
      ['a planting move', () => f.agent.patch(`/api/plantings/${f.plantingId}`).send({ cell: { x: 1, y: 1 } })],
      ['a seed edit', () => f.agent.patch(`/api/seeds/${f.seedId}`).send({ commonName: 'Cherry Tomato' })],
      ['a seed photo delete', () => f.agent.delete(`/api/seeds/${f.seedId}/photos/${photoId}`)],
      [
        'a harvest create',
        () => f.agent.post('/api/harvests').send({ gardenId: Number(f.gardenId), seedId: Number(f.seedId) }),
      ],
      [
        'PUT /planting-guide/done',
        () =>
          f.agent
            .put('/api/planting-guide/done')
            .send({ gardenId: Number(f.gardenId), seedId: Number(f.seedId), season, done: true }),
      ],
      [
        'PUT /planting-guide/overrides',
        () =>
          f.agent
            .put('/api/planting-guide/overrides')
            .send({ gardenId: Number(f.gardenId), seedId: Number(f.seedId), transplant: `${season}-05-10` }),
      ],
      ['a soil reading delete', () => f.agent.delete(`/api/soil-readings/${readingId}`)],
    ];

    for (const [label, write] of writes) {
      await clearWeeks();
      const res = await write();
      expect(res.status, label).toBeGreaterThanOrEqual(200);
      expect(res.status, label).toBeLessThan(300);
      expect(await weeks(f.accountId), label).toHaveLength(1);
    }
  });

  it('records nothing for the three excluded routes', async () => {
    const f = await fixture('p@example.com', true);

    await clearWeeks();
    const thumb = await f.agent
      .post(`/api/gardens/${f.gardenId}/thumbnail`)
      .set('Content-Type', 'image/png')
      .send(png);
    expect(thumb.status).toBe(200);

    const stage = await f.agent
      .patch(`/api/gardens/${f.gardenId}/plantings/displayed-stage`)
      .send({ plantingIds: [f.plantingId] });
    expect(stage.status).toBe(200);

    const contribute = await f.agent.post(`/api/seeds/${f.seedId}/contribute`).send({});
    expect(contribute.status).toBe(200);

    expect(await weeks(f.accountId)).toHaveLength(0);
  });

  it('records nothing for reads, a 404 or a 402', async () => {
    const f = await fixture('p@example.com', true);
    await clearWeeks();

    expect((await f.agent.get('/api/gardens')).status).toBe(200);
    expect((await f.agent.get(`/api/gardens/${f.gardenId}`)).status).toBe(200);
    expect((await f.agent.patch('/api/gardens/999999').send({ name: 'Nope' })).status).toBe(404);
    // Soil readings need Supporter; with beta Supporter access off this
    // participant is on the free tier.
    const { rows } = await pool.query<{ on: boolean }>(
      'SELECT supporter_access_on AS on FROM beta_settings WHERE id = 1',
    );
    await setSupporterAccess(false);
    try {
      const paid = await f.agent
        .post(`/api/gardens/${f.gardenId}/soil-readings`)
        .send({ bedId: Number(f.bedId), testDate: '2026-06-01', ph: 6.5 });
      expect(paid.status).toBe(402);
    } finally {
      await setSupporterAccess(rows[0].on);
    }

    expect(await weeks(f.accountId)).toHaveLength(0);
  });

  it('records nothing for feedback, micro-feedback, /api/me or /api/weather writes', async () => {
    const f = await fixture('p@example.com', true);
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO weather_connections (account_id, provider) VALUES ($1, 'public_weather') RETURNING id::text`,
      [f.accountId],
    );
    await clearWeeks();

    const feedback = await f.agent
      .post('/api/feedback')
      .send({ category: 'general', message: 'The planner works nicely.' });
    expect(feedback.status).toBeLessThan(300);
    expect((await f.agent.post('/api/micro-feedback/shown').send({ triggerKey: 'planted' })).status).toBe(200);
    expect((await f.agent.patch('/api/me/preferences').send({ units: 'metric' })).status).toBe(200);
    expect((await f.agent.delete(`/api/weather/connections/${rows[0].id}`)).status).toBeLessThan(300);

    expect(await weeks(f.accountId)).toHaveLength(0);
  });

  it("records nothing for a non-participant's writes", async () => {
    const f = await fixture('n@example.com', false);
    const bed = await f.agent.patch(`/api/gardens/${f.gardenId}/beds/${f.bedId}`).send({ label: 'Renamed' });
    expect(bed.status).toBeGreaterThanOrEqual(200);
    expect(bed.status).toBeLessThan(300);
    const seed = await f.agent.patch(`/api/seeds/${f.seedId}`).send({ commonName: 'Cherry Tomato' });
    expect(seed.status).toBeGreaterThanOrEqual(200);
    expect(seed.status).toBeLessThan(300);
    expect(await allWeeks()).toHaveLength(0);
  });

  it('puts Sunday night and Monday morning Pacific in their own weeks', async () => {
    const accountId = await createUser('p@example.com', true);
    const agent = await loginAgent('p@example.com');

    const sunday = new Date('2026-12-06T23:59:00-08:00');
    const monday = new Date('2026-12-07T00:01:00-08:00');
    setBetaActivityClockForTests(() => sunday);
    await createGarden(agent);
    setBetaActivityClockForTests(() => monday);
    await createGarden(agent);

    const rows = await weeks(accountId);
    expect(rows.map((r) => r.week_start)).toEqual(['2026-11-30', '2026-12-07']);
    expect(rows.map((r) => r.first_active_at.toISOString())).toEqual([
      sunday.toISOString(),
      monday.toISOString(),
    ]);
  });

  it('records nothing once BETA_ENDS_AT has passed', async () => {
    const accountId = await createUser('p@example.com', true);
    const agent = await loginAgent('p@example.com');
    const config = getServerConfig();
    const endsAt = new Date('2027-01-30T00:00:00-08:00');
    setServerConfigForTests({ ...config, betaEndsAt: endsAt });
    try {
      setBetaActivityClockForTests(() => endsAt);
      await createGarden(agent);
      setBetaActivityClockForTests(() => new Date(endsAt.getTime() + 86_400_000));
      await createGarden(agent);
      expect(await weeks(accountId)).toHaveLength(0);

      // A minute before the end still counts.
      setBetaActivityClockForTests(() => new Date(endsAt.getTime() - 60_000));
      await createGarden(agent);
      expect(await weeks(accountId)).toHaveLength(1);
    } finally {
      setServerConfigForTests(config);
    }
  });

  it('still answers the route when the insert fails, logs it, and tries again next time', async () => {
    const accountId = await createUser('p@example.com', true);
    const agent = await loginAgent('p@example.com');
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const realQuery = db.query.bind(db) as (...args: unknown[]) => unknown;
    const querySpy = vi.spyOn(db, 'query').mockImplementation(((...args: unknown[]) => {
      if (String(args[0]).includes('beta_active_weeks')) return Promise.reject(new Error('insert failed'));
      return realQuery(...args);
    }) as never);

    const res = await agent.post('/api/gardens').send(GARDEN);
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Plot');
    await betaActivitySettledForTests();
    expect(errorSpy).toHaveBeenCalledWith(
      'Recording a beta active week failed',
      expect.any(Error),
      { accountId },
    );
    expect(await weeks(accountId)).toHaveLength(0);

    // Nothing was remembered, so the next write inserts.
    querySpy.mockRestore();
    await createGarden(agent);
    expect(await weeks(accountId)).toHaveLength(1);
  });
});

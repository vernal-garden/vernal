import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { Pool } from 'pg';
import sharp from 'sharp';

vi.mock('../lib/r2', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/r2')>()),
  uploadToR2: vi.fn(),
  deleteFromR2: vi.fn(),
}));

vi.mock('../lib/r2Cleanup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/r2Cleanup')>()),
  drainSoon: vi.fn(),
}));

// The real processor, wrapped so a test can force a busy limiter.
vi.mock('../lib/imageProcessing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/imageProcessing')>();
  return { ...actual, processPhoto: vi.fn(actual.processPhoto) };
});

import { uploadToR2, deleteFromR2 } from '../lib/r2';
import { drainSoon } from '../lib/r2Cleanup';
import { ImageBusyError, processPhoto } from '../lib/imageProcessing';
import { refreshGardenBadges } from '../jobs/nightly';
import { addDays, currentSeason } from '../lib/plantingSchedule';
import app from '../index';

const uploadToR2Mock = vi.mocked(uploadToR2);
const deleteFromR2Mock = vi.mocked(deleteFromR2);

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL must be set to run tests');

const pool = new Pool({ connectionString: url });

type Agent = ReturnType<typeof request.agent>;

const SEASON = currentSeason(new Date());
const TODAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date());

async function queued() {
  const { rows } = await pool.query<{ bucket: string; path: string; is_prefix: boolean }>(
    'SELECT bucket, path, is_prefix FROM r2_deletions ORDER BY id',
  );
  return rows;
}

async function resetDb() {
  await pool.query(
    `TRUNCATE accounts, guest_sessions, gardens, beds, plantings, seeds, sowing_events,
              harvest_entries, r2_deletions RESTART IDENTITY CASCADE`,
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

async function guestAgent(): Promise<Agent> {
  const agent = request.agent(app);
  await agent.post('/api/auth/guest').expect(201);
  return agent;
}

async function createGarden(agent: Agent, name = 'Garden'): Promise<number> {
  const res = await agent
    .post('/api/gardens')
    .send({ name, style: 'grid', zone: '7b', growingMethod: 'in_ground' });
  expect(res.status).toBe(201);
  return Number(res.body.id);
}

async function guestSessionOf(gardenId: number): Promise<string> {
  const { rows } = await pool.query<{ guest_session_id: string }>(
    'SELECT guest_session_id FROM gardens WHERE id = $1',
    [gardenId],
  );
  return rows[0].guest_session_id;
}

async function createBed(gardenId: number, label = 'Bed'): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO beds (garden_id, season, type, label, grid_x, grid_y, grid_cols, grid_rows)
     VALUES ($1, $2, 'grid', $3, 0, 0, 4, 4) RETURNING id`,
    [gardenId, SEASON, label],
  );
  return rows[0].id;
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
  owner: { accountId?: number; guestSessionId?: string },
  commonName: string,
): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO seeds (owner_id, guest_session_id, common_name, plant_family, origin)
     VALUES ($1, $2, $3, 'Fam', 'user_created') RETURNING id`,
    [owner.accountId ?? null, owner.guestSessionId ?? null, commonName],
  );
  return rows[0].id;
}

async function plant(
  bedId: number,
  gardenId: number,
  seed: { seedId?: number; cambiumSeedId?: number },
  harvestReady = false,
): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO plantings (bed_id, garden_id, season, seed_id, cambium_seed_id, harvest_ready)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [bedId, gardenId, SEASON, seed.seedId ?? null, seed.cambiumSeedId ?? null, harvestReady],
  );
  return rows[0].id;
}

async function sowingEvent(
  gardenId: number,
  seed: { seedId?: number; cambiumSeedId?: number },
  done: boolean,
  season = SEASON,
): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO sowing_events (garden_id, seed_id, cambium_seed_id, season, marked_done_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [gardenId, seed.seedId ?? null, seed.cambiumSeedId ?? null, season, done ? new Date() : null],
  );
  return rows[0].id;
}

async function createEntry(agent: Agent, body: Record<string, unknown>) {
  const res = await agent.post('/api/harvests').send(body);
  expect(res.status).toBe(201);
  return res.body as { id: string; [k: string]: unknown };
}

let peaId: number;
let tomatoId: number;
let jpeg: Buffer;

beforeAll(async () => {
  jpeg = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#4a7' } })
    .jpeg()
    .toBuffer();
  await resetDb();
  peaId = await createCambiumSeed('Pea', 'Pisum sativum');
  tomatoId = await createCambiumSeed('Tomato', 'Solanum lycopersicum');
});

beforeEach(async () => {
  await pool.query('TRUNCATE r2_deletions RESTART IDENTITY');
  vi.mocked(drainSoon).mockClear();
  vi.mocked(processPhoto).mockClear();
  uploadToR2Mock.mockReset();
  uploadToR2Mock.mockResolvedValue(undefined);
  deleteFromR2Mock.mockReset();
  deleteFromR2Mock.mockResolvedValue(undefined);
});

afterAll(async () => {
  await pool.end();
});

// ── Guest CRUD ────────────────────────────────────────────────────────────────

describe('Guest CRUD', () => {
  it('creates, lists, updates and deletes an entry in their garden', async () => {
    const guest = await guestAgent();
    const gardenId = await createGarden(guest, 'Guest Plot');
    const bedId = await createBed(gardenId, 'North');

    const created = await createEntry(guest, {
      gardenId,
      cambiumSeedId: peaId,
      bedId,
      quantity: 1.5,
      unit: 'kg',
      qualityRating: 4,
      notes: '  sweet  ',
    });
    expect(created).toMatchObject({
      gardenId: String(gardenId),
      gardenName: 'Guest Plot',
      bedId: String(bedId),
      bedLabel: 'North',
      seedId: null,
      cambiumSeedId: String(peaId),
      commonName: 'Pea',
      scientificName: 'Pisum sativum',
      harvestDate: TODAY,
      season: SEASON,
      quantity: 1.5,
      unit: 'kg',
      qualityRating: 4,
      notes: 'sweet',
      photos: [],
      sowingEventId: null,
    });
    expect(typeof created.id).toBe('string');

    const list = await guest.get('/api/harvests');
    expect(list.status).toBe(200);
    expect(list.body.data.map((e: { id: string }) => e.id)).toEqual([created.id]);

    const patched = await guest
      .patch(`/api/harvests/${created.id}`)
      .send({ notes: 'very sweet', qualityRating: 5 });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ notes: 'very sweet', qualityRating: 5, quantity: 1.5 });

    const fetched = await guest.get(`/api/harvests/${created.id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.notes).toBe('very sweet');

    expect((await guest.delete(`/api/harvests/${created.id}`)).status).toBe(204);
    expect((await guest.get(`/api/harvests/${created.id}`)).status).toBe(404);
  });

  it('moving to another garden clears the bed unless a new one is given', async () => {
    // Guests get one garden, so this needs an account.
    await createUser('harvest-mover@example.com');
    const guest = await loginAgent('harvest-mover@example.com');
    const g1 = await createGarden(guest, 'One');
    const g2 = await createGarden(guest, 'Two');
    const bed1 = await createBed(g1);
    const bed2 = await createBed(g2);
    const entry = await createEntry(guest, { gardenId: g1, cambiumSeedId: peaId, bedId: bed1 });

    const moved = await guest.patch(`/api/harvests/${entry.id}`).send({ gardenId: g2 });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ gardenId: String(g2), bedId: null });

    const withBed = await guest
      .patch(`/api/harvests/${entry.id}`)
      .send({ gardenId: g1, bedId: bed1 });
    expect(withBed.body).toMatchObject({ gardenId: String(g1), bedId: String(bed1) });

    const badBed = await guest.patch(`/api/harvests/${entry.id}`).send({ bedId: bed2 });
    expect(badBed.status).toBe(400);
  });

  it('400 for a non-numeric id', async () => {
    const guest = await guestAgent();
    expect((await guest.get('/api/harvests/abc')).status).toBe(400);
    expect((await guest.patch('/api/harvests/abc').send({ notes: 'x' })).status).toBe(400);
    expect((await guest.delete('/api/harvests/abc')).status).toBe(400);
  });

  it('401 with no session', async () => {
    expect((await request(app).get('/api/harvests')).status).toBe(401);
    expect((await request(app).post('/api/harvests').send({})).status).toBe(401);
  });
});

// ── Ownership ─────────────────────────────────────────────────────────────────

describe('Ownership', () => {
  let me: Agent;
  let myGarden: number;
  let myEntry: string;
  let theirGarden: number;
  let theirEntry: string;

  beforeAll(async () => {
    await createUser('harvest-owner@example.com', 'supporter');
    me = await loginAgent('harvest-owner@example.com');
    myGarden = await createGarden(me);
    myEntry = (await createEntry(me, { gardenId: myGarden, cambiumSeedId: peaId })).id;

    const them = await guestAgent();
    theirGarden = await createGarden(them);
    theirEntry = (await createEntry(them, { gardenId: theirGarden, cambiumSeedId: peaId })).id;
  });

  it("another session's garden or entry → 404 on every route", async () => {
    const photoKey = `harvest-photos/${theirEntry}/11111111-1111-4111-8111-111111111111.jpg`;
    // Sent one at a time: each supertest request opens and closes its own
    // server, and ten in parallel caused intermittent ECONNRESET in CI. Each is
    // wrapped in a function because building a request already calls
    // app.listen(0), so a list of built requests would still open all ten at once.
    const routes: Array<[string, () => request.Test]> = [
      ['POST /', () => me.post('/api/harvests').send({ gardenId: theirGarden, cambiumSeedId: peaId })],
      ['GET /:id', () => me.get(`/api/harvests/${theirEntry}`)],
      ['PATCH /:id', () => me.patch(`/api/harvests/${theirEntry}`).send({ notes: 'mine now' })],
      ['PATCH /:id move garden', () => me.patch(`/api/harvests/${myEntry}`).send({ gardenId: theirGarden })],
      ['DELETE /:id', () => me.delete(`/api/harvests/${theirEntry}`)],
      ['GET /?gardenId', () => me.get(`/api/harvests?gardenId=${theirGarden}`)],
      ['GET /export.csv', () => me.get(`/api/harvests/export.csv?gardenId=${theirGarden}`)],
      [
        'POST /:id/photos',
        () =>
          me
            .post(`/api/harvests/${theirEntry}/photos`)
            .set('Content-Type', 'image/jpeg')
            .send(jpeg),
      ],
      [
        'DELETE /:id/photos',
        () => me.delete(`/api/harvests/${theirEntry}/photos?key=${encodeURIComponent(photoKey)}`),
      ],
    ];
    for (const [label, send] of routes) {
      const r = await send();
      expect(r.status, label).toBe(404);
    }
    expect(uploadToR2Mock).not.toHaveBeenCalled();

    const list = await me.get('/api/harvests');
    expect(list.body.data.map((e: { id: string }) => e.id)).toEqual([myEntry]);
  });
});

// ── Validation ────────────────────────────────────────────────────────────────

describe('Validation', () => {
  let guest: Agent;
  let accountId: number;
  let gardenId: number;
  let otherGardenId: number;

  beforeAll(async () => {
    accountId = await createUser('harvest-validation@example.com');
    guest = await loginAgent('harvest-validation@example.com');
    gardenId = await createGarden(guest, 'Main');
    otherGardenId = await createGarden(guest, 'Other');
  });

  const post = (body: Record<string, unknown>) =>
    guest.post('/api/harvests').send({ gardenId, cambiumSeedId: peaId, ...body });

  it('plant: both keys → 400', async () => {
    const seedId = await createPersonalSeed({ accountId }, 'Own Bean');
    expect((await post({ seedId })).status).toBe(400);
  });

  it("plant: another user's personal seed → 400", async () => {
    const otherAccount = await createUser('harvest-seed-owner@example.com');
    const seedId = await createPersonalSeed({ accountId: otherAccount }, 'Their Bean');
    const res = await guest.post('/api/harvests').send({ gardenId, seedId });
    expect(res.status).toBe(400);
  });

  it('plant: unknown cambium id → 400', async () => {
    expect((await post({ cambiumSeedId: 999999 })).status).toBe(400);
  });

  it('plant: neither key → 400', async () => {
    expect((await guest.post('/api/harvests').send({ gardenId })).status).toBe(400);
  });

  it('bedId from a different garden → 400', async () => {
    const bedId = await createBed(otherGardenId);
    expect((await post({ bedId })).status).toBe(400);
  });

  it('future harvestDate → 400; today accepted; date round-trips unchanged', async () => {
    expect((await post({ harvestDate: addDays(TODAY, 1) })).status).toBe(400);
    expect((await post({ harvestDate: '2026-02-30' })).status).toBe(400);

    const today = await post({ harvestDate: TODAY });
    expect(today.status).toBe(201);
    expect(today.body.harvestDate).toBe(TODAY);

    // A DST-change day in Pacific time.
    const dst = await post({ harvestDate: '2025-03-09' });
    expect(dst.status).toBe(201);
    expect(dst.body.harvestDate).toBe('2025-03-09');
    expect(dst.body.season).toBe(2025);
    const refetched = await guest.get(`/api/harvests/${dst.body.id}`);
    expect(refetched.body.harvestDate).toBe('2025-03-09');

    const patched = await guest
      .patch(`/api/harvests/${dst.body.id}`)
      .send({ harvestDate: '2025-11-02' });
    expect(patched.body.harvestDate).toBe('2025-11-02');
  });

  it('quantity without unit → 400; unit cup → 400; 0 accepted', async () => {
    expect((await post({ quantity: 2 })).status).toBe(400);
    expect((await post({ unit: 'g' })).status).toBe(400);
    expect((await post({ quantity: 2, unit: 'cup' })).status).toBe(400);
    expect((await post({ quantity: -1, unit: 'g' })).status).toBe(400);
    expect((await post({ quantity: 100001, unit: 'g' })).status).toBe(400);

    const zero = await post({ quantity: 0, unit: 'g' });
    expect(zero.status).toBe(201);
    expect(zero.body).toMatchObject({ quantity: 0, unit: 'g' });
  });

  it('qualityRating must be 1..5', async () => {
    expect((await post({ qualityRating: 0 })).status).toBe(400);
    expect((await post({ qualityRating: 2.5 })).status).toBe(400);
  });

  it('notes over 5000 → 400; empty → null', async () => {
    expect((await post({ notes: 'x'.repeat(5001) })).status).toBe(400);
    const ok = await post({ notes: 'x'.repeat(5000) });
    expect(ok.status).toBe(201);
    const empty = await post({ notes: '   ' });
    expect(empty.body.notes).toBeNull();
  });
});

// ── Sowing auto-link ──────────────────────────────────────────────────────────

describe('Sowing event link', () => {
  it('links to a done event, not an undone one, and reuses it for a second entry', async () => {
    await createUser('harvest-sower@example.com');
    const guest = await loginAgent('harvest-sower@example.com');
    const gardenId = await createGarden(guest);
    const otherGardenId = await createGarden(guest, 'Elsewhere');

    const doneEvent = await sowingEvent(gardenId, { cambiumSeedId: peaId }, true);
    await sowingEvent(gardenId, { cambiumSeedId: tomatoId }, false);

    const first = await createEntry(guest, { gardenId, cambiumSeedId: peaId });
    expect(first.sowingEventId).toBe(String(doneEvent));

    const second = await createEntry(guest, { gardenId, cambiumSeedId: peaId });
    expect(second.sowingEventId).toBe(String(doneEvent));

    const undone = await createEntry(guest, { gardenId, cambiumSeedId: tomatoId });
    expect(undone.sowingEventId).toBeNull();

    // A different season's done event isn't picked up.
    await sowingEvent(gardenId, { cambiumSeedId: tomatoId }, true, SEASON - 1);
    const lastYear = await createEntry(guest, {
      gardenId,
      cambiumSeedId: tomatoId,
      harvestDate: `${SEASON - 2}-07-01`,
    });
    expect(lastYear.sowingEventId).toBeNull();

    const optOut = await createEntry(guest, { gardenId, cambiumSeedId: peaId, sowingEventId: null });
    expect(optOut.sowingEventId).toBeNull();

    // Explicit event from another garden → 400.
    const foreignEvent = await sowingEvent(otherGardenId, { cambiumSeedId: peaId }, true);
    const bad = await guest
      .post('/api/harvests')
      .send({ gardenId, cambiumSeedId: peaId, sowingEventId: foreignEvent });
    expect(bad.status).toBe(400);

    // Unlink with null, relink explicitly.
    const unlinked = await guest.patch(`/api/harvests/${first.id}`).send({ sowingEventId: null });
    expect(unlinked.body.sowingEventId).toBeNull();
    const relinked = await guest
      .patch(`/api/harvests/${first.id}`)
      .send({ sowingEventId: doneEvent });
    expect(relinked.body.sowingEventId).toBe(String(doneEvent));
  });
});

// ── Harvest-ready indicator ───────────────────────────────────────────────────

describe('Harvest-ready indicator', () => {
  it("dismisses that seed's harvest-ready plantings and drops the garden's count", async () => {
    const guest = await guestAgent();
    const gardenId = await createGarden(guest);
    const bedId = await createBed(gardenId);
    const peaPlanting = await plant(bedId, gardenId, { cambiumSeedId: peaId }, true);
    const tomatoPlanting = await plant(bedId, gardenId, { cambiumSeedId: tomatoId }, true);

    await refreshGardenBadges();
    const before = await pool.query('SELECT harvestable_count FROM gardens WHERE id = $1', [
      gardenId,
    ]);
    expect(before.rows[0].harvestable_count).toBe(2);

    await createEntry(guest, { gardenId, cambiumSeedId: peaId });

    const { rows } = await pool.query<{ id: number; indicator_dismissed_at: Date | null }>(
      'SELECT id, indicator_dismissed_at FROM plantings WHERE id = ANY($1::int[])',
      [[peaPlanting, tomatoPlanting]],
    );
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.indicator_dismissed_at]));
    expect(byId[peaPlanting]).not.toBeNull();
    expect(byId[tomatoPlanting]).toBeNull();

    const after = await pool.query('SELECT harvestable_count FROM gardens WHERE id = $1', [
      gardenId,
    ]);
    expect(after.rows[0].harvestable_count).toBe(1);
  });
});

// ── List ──────────────────────────────────────────────────────────────────────

describe('List', () => {
  let guest: Agent;
  const ids: string[] = [];

  beforeAll(async () => {
    guest = await guestAgent();
    const gardenId = await createGarden(guest);
    const dates = [`${SEASON}-01-02`, TODAY, `${SEASON - 1}-08-15`, `${SEASON}-01-01`, `${SEASON}-01-02`];
    for (const [i, harvestDate] of dates.entries()) {
      const entry = await createEntry(guest, {
        gardenId,
        cambiumSeedId: i === 2 ? tomatoId : peaId,
        harvestDate,
        notes: i === 3 ? 'Zucchini_overload 100%' : `note ${i}`,
      });
      ids.push(entry.id);
    }
  });

  it('newest first, ties broken by id desc', async () => {
    const res = await guest.get('/api/harvests');
    expect(res.status).toBe(200);
    const data = res.body.data as { id: string; harvestDate: string }[];
    expect(data).toHaveLength(5);
    const dates = data.map((e) => e.harvestDate);
    expect(dates).toEqual([...dates].sort().reverse());
    // The two same-day entries come back highest id first.
    const sameDay = data.filter((e) => e.harvestDate === `${SEASON}-01-02`).map((e) => e.id);
    expect(sameDay).toEqual([ids[4], ids[0]]);
    expect(res.body.nextCursor).toBeNull();
  });

  it('cursor paging returns every entry exactly once', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const res: request.Response = await guest
        .get('/api/harvests')
        .query(cursor ? { limit: 2, cursor } : { limit: 2 });
      expect(res.status).toBe(200);
      seen.push(...res.body.data.map((e: { id: string }) => e.id));
      cursor = res.body.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen)).toEqual(new Set(ids));
  });

  it('invalid cursor or limit → 400', async () => {
    expect((await guest.get('/api/harvests?cursor=not-a-cursor')).status).toBe(400);
    const forged = Buffer.from(JSON.stringify(['yesterday', 1])).toString('base64');
    expect((await guest.get(`/api/harvests?cursor=${forged}`)).status).toBe(400);
    expect((await guest.get('/api/harvests?limit=101')).status).toBe(400);
  });

  it('repeated q → 400, not 500', async () => {
    expect((await guest.get('/api/harvests?q=a&q=b')).status).toBe(400);
    expect((await guest.get('/api/harvests/export.csv?q=a&q=b')).status).toBe(400);
    expect((await guest.get('/api/harvests/plant-options?q=a&q=b')).status).toBe(400);
  });

  it('q matches a note (LIKE wildcards are literal)', async () => {
    const res = await guest.get('/api/harvests').query({ q: 'zucchini_overload 100%' });
    expect(res.body.data.map((e: { id: string }) => e.id)).toEqual([ids[3]]);
    const wildcard = await guest.get('/api/harvests').query({ q: '%' });
    expect(wildcard.body.data.map((e: { id: string }) => e.id)).toEqual([ids[3]]);
  });

  it('q matches the common name', async () => {
    const res = await guest.get('/api/harvests').query({ q: 'tomat' });
    expect(res.body.data.map((e: { id: string }) => e.id)).toEqual([ids[2]]);
  });

  it('seed filter, repeatable', async () => {
    const one = await guest.get(`/api/harvests?seed=cambium:${tomatoId}`);
    expect(one.body.data.map((e: { id: string }) => e.id)).toEqual([ids[2]]);
    const both = await guest.get(`/api/harvests?seed=cambium:${tomatoId}&seed=cambium:${peaId}`);
    expect(both.body.data).toHaveLength(5);
    expect((await guest.get('/api/harvests?seed=pea')).status).toBe(400);
  });

  it('season, from and to filters', async () => {
    const lastYear = await guest.get(`/api/harvests?season=${SEASON - 1}`);
    expect(lastYear.body.data.map((e: { id: string }) => e.id)).toEqual([ids[2]]);
    const range = await guest.get(`/api/harvests?from=${SEASON}-01-01&to=${SEASON}-01-01`);
    expect(range.body.data.map((e: { id: string }) => e.id)).toEqual([ids[3]]);
  });

  it('seasons lists only seasons with data, ignoring filters', async () => {
    const res = await guest.get(`/api/harvests?season=${SEASON - 1}`);
    expect(res.body.seasons).toEqual([SEASON, SEASON - 1]);
  });
});

// ── Export ────────────────────────────────────────────────────────────────────

describe('Export', () => {
  it('sends a CSV with a dated filename, a header row and safe cells', async () => {
    const guest = await guestAgent();
    const gardenId = await createGarden(guest, 'Back, "Yard"');
    await createEntry(guest, {
      gardenId,
      cambiumSeedId: peaId,
      harvestDate: `${SEASON}-01-01`,
      notes: '=HYPERLINK("x")',
    });
    await createEntry(guest, {
      gardenId,
      cambiumSeedId: tomatoId,
      harvestDate: `${SEASON}-01-02`,
      quantity: 2.5,
      unit: 'lb',
      qualityRating: 3,
      notes: 'big, "juicy"',
    });

    const res = await guest.get('/api/harvests/export.csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="vernal-harvest-log-${TODAY}.csv"`,
    );

    const lines = res.text.split('\r\n');
    expect(lines[0]).toBe(
      'Date,Plant,Scientific name,Garden,Bed,Quantity,Unit,Quality,Notes,Photos,Linked sowing',
    );
    expect(lines[1]).toBe(
      `${SEASON}-01-02,Tomato,Solanum lycopersicum,"Back, ""Yard""",,2.5,lb,3,"big, ""juicy""",0,no`,
    );
    expect(lines[2]).toBe(
      `${SEASON}-01-01,Pea,Pisum sativum,"Back, ""Yard""",,,,,"'=HYPERLINK(""x"")",0,no`,
    );
    expect(lines[3]).toBe('');
  });

  it('applies the list filters', async () => {
    const guest = await guestAgent();
    const gardenId = await createGarden(guest);
    await createEntry(guest, { gardenId, cambiumSeedId: peaId, notes: 'keep' });
    await createEntry(guest, { gardenId, cambiumSeedId: tomatoId, notes: 'skip' });
    const res = await guest.get('/api/harvests/export.csv?q=keep');
    expect(res.text.trim().split('\r\n')).toHaveLength(2);
  });
});

// ── Plant options ─────────────────────────────────────────────────────────────

describe('Plant options', () => {
  let guest: Agent;
  let basilId: number;

  beforeAll(async () => {
    guest = await guestAgent();
    const gardenId = await createGarden(guest);
    const bedId = await createBed(gardenId);
    await plant(bedId, gardenId, { cambiumSeedId: tomatoId });
    await plant(bedId, gardenId, { cambiumSeedId: tomatoId });
    basilId = await createPersonalSeed({ guestSessionId: await guestSessionOf(gardenId) }, 'Basil');
  });

  it('planted seeds come first, then personal seeds, no cambium without q', async () => {
    const res = await guest.get('/api/harvests/plant-options');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      {
        seedId: null,
        cambiumSeedId: String(tomatoId),
        commonName: 'Tomato',
        scientificName: 'Solanum lycopersicum',
        source: 'planted',
      },
      {
        seedId: String(basilId),
        cambiumSeedId: null,
        commonName: 'Basil',
        scientificName: null,
        source: 'personal',
      },
    ]);
  });

  it('cambium results only with a 2+ char q, deduplicated against planted', async () => {
    const one = await guest.get('/api/harvests/plant-options?q=p');
    expect(one.body.data.some((o: { source: string }) => o.source === 'cambium')).toBe(false);

    const two = await guest.get('/api/harvests/plant-options?q=pis');
    expect(two.body.data).toEqual([
      expect.objectContaining({ cambiumSeedId: String(peaId), source: 'cambium' }),
    ]);

    const tom = await guest.get('/api/harvests/plant-options?q=tom');
    expect(tom.body.data).toEqual([
      expect.objectContaining({ cambiumSeedId: String(tomatoId), source: 'planted' }),
    ]);
  });
});

// ── Photos ────────────────────────────────────────────────────────────────────

describe('Photos', () => {
  let supporter: Agent;
  let free: Agent;
  let guest: Agent;
  let entryId: string;
  let gardenId: number;

  const uuid = (n: number) => `${String(n).repeat(8)}-1111-4111-8111-111111111111`;
  const keyFor = (id: string, n: number) => `harvest-photos/${id}/${uuid(n)}.jpg`;

  beforeAll(async () => {
    await createUser('harvest-supporter@example.com', 'supporter');
    await createUser('harvest-free@example.com');
    supporter = await loginAgent('harvest-supporter@example.com');
    free = await loginAgent('harvest-free@example.com');
    guest = await guestAgent();
    gardenId = await createGarden(supporter);
    entryId = (await createEntry(supporter, { gardenId, cambiumSeedId: peaId })).id;
  });

  const postPhoto = (agent: Agent, id: string, body: Buffer = jpeg) =>
    agent.post(`/api/harvests/${id}/photos`).set('Content-Type', 'image/jpeg').send(body);

  // An entry of the supporter's own with `count` photos already attached.
  async function entryWithPhotos(count: number): Promise<string> {
    const id = (await createEntry(supporter, { gardenId, cambiumSeedId: peaId })).id;
    const photos = Array.from({ length: count }, (_, i) => ({ key: keyFor(id, i + 1) }));
    await pool.query('UPDATE harvest_entries SET photos = $2::jsonb WHERE id = $1', [
      id,
      JSON.stringify(photos),
    ]);
    return id;
  }

  it('free account → 402; guest → 401', async () => {
    const free402 = await postPhoto(free, entryId);
    expect(free402.status).toBe(402);
    expect(free402.body.upgrade_required).toBe(true);
    // Photo removal is open to free accounts (read-only paid data); on another
    // account's entry that is the ownership 404, not 402.
    expect((await free.delete(`/api/harvests/${entryId}/photos?key=x`)).status).toBe(404);

    const guest401 = await postPhoto(guest, entryId);
    expect(guest401.status).toBe(401);
    expect(uploadToR2Mock).not.toHaveBeenCalled();
  });

  it('a JSON body or non-image bytes → 400, nothing uploaded', async () => {
    const json = await supporter
      .post(`/api/harvests/${entryId}/photos`)
      .send({ key: keyFor(entryId, 1) });
    expect(json.status).toBe(400);
    expect(json.body).toEqual({ error: "That file isn't a supported image." });

    const text = await postPhoto(supporter, entryId, Buffer.from('hello, not an image'));
    expect(text.status).toBe(400);
    expect(text.body).toEqual({ error: "That file isn't a supported image." });
    expect(uploadToR2Mock).not.toHaveBeenCalled();
  });

  it('busy image limiter → 503, nothing uploaded', async () => {
    vi.mocked(processPhoto).mockRejectedValueOnce(new ImageBusyError());
    const res = await postPhoto(supporter, entryId);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'Busy, try again.' });
    expect(uploadToR2Mock).not.toHaveBeenCalled();
  });

  it('503 when R2 is not configured, nothing queued', async () => {
    uploadToR2Mock.mockRejectedValueOnce(new Error('R2 not configured: ...'));
    const res = await postPhoto(supporter, entryId);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'Photo storage is not configured.' });
    expect(await queued()).toEqual([]);
  });

  it('the limit is reached while uploading → 409 and the upload is queued for deletion', async () => {
    const id = await entryWithPhotos(2);
    uploadToR2Mock.mockImplementationOnce(async () => {
      await pool.query(
        `UPDATE harvest_entries SET photos = photos || jsonb_build_array($2::jsonb) WHERE id = $1`,
        [id, JSON.stringify({ key: keyFor(id, 3) })],
      );
    });
    const res = await postPhoto(supporter, id);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Up to 3 photos per harvest.' });
    expect(uploadToR2Mock).toHaveBeenCalledTimes(1);
    const key = uploadToR2Mock.mock.calls[0][0];
    expect(await queued()).toEqual([{ bucket: 'public', path: key, is_prefix: false }]);
    expect(drainSoon).toHaveBeenCalled();
  });

  it('the entry is deleted while uploading → 404 and the upload is queued for deletion', async () => {
    const id = await entryWithPhotos(0);
    uploadToR2Mock.mockImplementationOnce(async () => {
      await pool.query('DELETE FROM harvest_entries WHERE id = $1', [id]);
    });
    const res = await postPhoto(supporter, id);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Harvest not found' });
    expect(uploadToR2Mock).toHaveBeenCalledTimes(1);
    const key = uploadToR2Mock.mock.calls[0][0];
    expect(await queued()).toEqual([{ bucket: 'public', path: key, is_prefix: false }]);
    expect(drainSoon).toHaveBeenCalled();
  });

  it('POST upload-url → 404 (removed)', async () => {
    const res = await supporter
      .post(`/api/harvests/${entryId}/photos/upload-url`)
      .send({ contentType: 'image/jpeg', size: 1000 });
    expect(res.status).toBe(404);
  });

  it('attaches up to three; a fourth → 409 without uploading; delete removes one', async () => {
    const keys: string[] = [];
    for (const n of [1, 2, 3]) {
      const res = await postPhoto(supporter, entryId);
      expect(res.status).toBe(200);
      expect(res.body.photos).toHaveLength(n);
      const [key, body, contentType] = uploadToR2Mock.mock.calls[n - 1];
      expect(key).toMatch(new RegExp(`^harvest-photos/${entryId}/[0-9a-f-]{36}\\.jpg$`));
      expect([...(body as Buffer).subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
      expect(contentType).toBe('image/jpeg');
      expect(res.body.photos[n - 1]).toEqual({ key, url: `/api/media/${key}` });
      keys.push(key);
    }
    expect(await queued()).toEqual([]);
    // Only the key is stored; the client URL is built on the way out.
    const stored = await pool.query('SELECT photos FROM harvest_entries WHERE id = $1', [entryId]);
    expect(stored.rows[0].photos).toEqual(keys.map((key) => ({ key })));

    const fourth = await postPhoto(supporter, entryId);
    expect(fourth.status).toBe(409);
    expect(fourth.body).toEqual({ error: 'Up to 3 photos per harvest.' });
    expect(uploadToR2Mock).toHaveBeenCalledTimes(3);

    const removed = await supporter.delete(
      `/api/harvests/${entryId}/photos?key=${encodeURIComponent(keys[1])}`,
    );
    expect(removed.status).toBe(200);
    expect(removed.body.photos.map((p: { key: string }) => p.key)).toEqual([keys[0], keys[2]]);
    expect(await queued()).toEqual([
      { bucket: 'public', path: keys[1], is_prefix: false },
    ]);
    expect(drainSoon).toHaveBeenCalled();

    const missing = await supporter.delete(
      `/api/harvests/${entryId}/photos?key=${encodeURIComponent(keyFor(entryId, 2))}`,
    );
    expect(missing.status).toBe(404);
  });

  it('free account can remove a photo from its own entry but not add one', async () => {
    await createUser('harvest-lapsed@example.com');
    const lapsed = await loginAgent('harvest-lapsed@example.com');
    const gardenId = await createGarden(lapsed);
    const ownId = (await createEntry(lapsed, { gardenId, cambiumSeedId: peaId })).id;
    // Photos added while the account was a Supporter.
    const photos = [5, 6].map((n) => ({ key: keyFor(ownId, n) }));
    await pool.query('UPDATE harvest_entries SET photos = $2::jsonb WHERE id = $1', [
      ownId,
      JSON.stringify(photos),
    ]);

    const removed = await lapsed.delete(
      `/api/harvests/${ownId}/photos?key=${encodeURIComponent(keyFor(ownId, 5))}`,
    );
    expect(removed.status).toBe(200);
    expect(removed.body.photos.map((p: { key: string }) => p.key)).toEqual([keyFor(ownId, 6)]);
    expect(await queued()).toEqual([
      { bucket: 'public', path: keyFor(ownId, 5), is_prefix: false },
    ]);

    const attach = await postPhoto(lapsed, ownId);
    expect(attach.status).toBe(402);
    expect(attach.body.upgrade_required).toBe(true);
    expect(uploadToR2Mock).not.toHaveBeenCalled();
  });

  it('a photo stored with an old public url is returned with its media url', async () => {
    const id = await entryWithPhotos(0);
    const key = keyFor(id, 7);
    await pool.query('UPDATE harvest_entries SET photos = $2::jsonb WHERE id = $1', [
      id,
      JSON.stringify([{ key, url: 'https://old.r2.dev/' + key }]),
    ]);
    const res = await supporter.get(`/api/harvests/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.photos).toEqual([{ key, url: '/api/media/' + key }]);
  });

  it("DELETE of another user's harvest → 404 and queues nothing", async () => {
    const res = await free.delete(`/api/harvests/${entryId}`);
    expect(res.status).toBe(404);
    expect(await queued()).toEqual([]);
  });

  it("DELETE /api/harvests/:id queues the entry's photo folder", async () => {
    const res = await supporter.delete(`/api/harvests/${entryId}`);
    expect(res.status).toBe(204);
    expect(await queued()).toEqual([
      { bucket: 'public', path: `harvest-photos/${entryId}/`, is_prefix: true },
    ]);
    expect(drainSoon).toHaveBeenCalled();
  });
});

// ── Row cap (5000 per garden) ─────────────────────────────────────────────────

describe('Row cap', () => {
  it('allows the 5000th entry and refuses the 5001st', async () => {
    const guest = await guestAgent();
    const gardenId = await createGarden(guest, 'Cap Plot');
    await pool.query(
      `INSERT INTO harvest_entries (garden_id, cambium_seed_id)
       SELECT $1, $2 FROM generate_series(1, 4999)`,
      [gardenId, peaId],
    );

    await createEntry(guest, { gardenId, cambiumSeedId: peaId });
    const res = await guest.post('/api/harvests').send({ gardenId, cambiumSeedId: peaId });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('A garden can have up to 5000 harvest entries.');

    const { rows } = await pool.query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM harvest_entries WHERE garden_id = $1',
      [gardenId],
    );
    expect(rows[0].n).toBe(5000);
  });
});

describe('search bounds', () => {
  it('rejects q over 100 characters on list and plant-options', async () => {
    const guest = await guestAgent();
    const long = 'a'.repeat(101);
    const list = await guest.get(`/api/harvests?q=${long}`);
    expect(list.status).toBe(400);
    expect(list.body.error).toBe('q must be 100 characters or fewer');
    const opts = await guest.get(`/api/harvests/plant-options?q=${long}`);
    expect(opts.status).toBe(400);
    expect(opts.body.error).toBe('q must be 100 characters or fewer');
    expect((await guest.get(`/api/harvests?q=${'a'.repeat(100)}`)).status).toBe(200);
  });
});

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { Pool } from 'pg';

vi.mock('../lib/r2', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/r2')>()),
  uploadToR2: vi.fn(async (key: string) => `${process.env.R2_PUBLIC_BASE_URL}/${key}`),
  deleteFromR2: vi.fn(async () => {}),
}));

vi.mock('../lib/r2Cleanup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/r2Cleanup')>()),
  drainSoon: vi.fn(),
}));

import { uploadToR2, deleteFromR2 } from '../lib/r2';
import { drainSoon } from '../lib/r2Cleanup';
import app from '../index';
import { currentSeason } from '../lib/season';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL must be set to run tests');

const pool = new Pool({ connectionString: url });

async function resetDb() {
  await pool.query(
    'TRUNCATE accounts, guest_sessions, gardens, beds, harvest_entries, r2_deletions RESTART IDENTITY CASCADE',
  );
}

async function queued() {
  const { rows } = await pool.query<{ bucket: string; path: string; is_prefix: boolean }>(
    'SELECT bucket, path, is_prefix FROM r2_deletions ORDER BY id',
  );
  return rows;
}

async function createUser(email: string, password = 'Password123!'): Promise<number> {
  const hash = await bcrypt.hash(password, 4);
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO accounts
       (email, password_hash, zone, zone_location_label, email_verified)
     VALUES ($1, $2, '7b', 'Test City', true)
     RETURNING id`,
    [email, hash],
  );
  return rows[0].id;
}

async function loginAgent(email: string, password = 'Password123!') {
  const agent = request.agent(app);
  await agent.post('/api/auth/guest');
  await agent.post('/api/auth/login').send({ email, password });
  return agent;
}

const BASE_GARDEN = { name: 'My Backyard', style: 'grid', zone: '7b', growingMethod: 'raised_bed' };

beforeAll(resetDb);
afterAll(() => pool.end());

// ── Gardens ───────────────────────────────────────────────────────────────────

describe('Gardens — authenticated CRUD', () => {
  let agent: ReturnType<typeof request.agent>;

  beforeAll(async () => {
    await createUser('garden-user@example.com');
    agent = await loginAgent('garden-user@example.com');
  });

  it('creates a garden', async () => {
    const res = await agent.post('/api/gardens').send(BASE_GARDEN);
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('My Backyard');
    expect(res.body.style).toBe('grid');
    expect(res.body.zone).toBe('7b');
    expect(res.body.id).toBeDefined();
  });

  it('returns 400 when style is missing', async () => {
    const res = await agent.post('/api/gardens').send({ name: 'No Style', zone: '7b' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/style/);
  });

  it('returns 400 when style is invalid', async () => {
    const res = await agent
      .post('/api/gardens')
      .send({ name: 'Bad Style', style: 'hexagonal', zone: '7b' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when zone is missing', async () => {
    const res = await agent.post('/api/gardens').send({ name: 'No Zone', style: 'grid' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/zone/);
  });

  it('returns 400 when growingMethod is missing', async () => {
    const res = await agent
      .post('/api/gardens')
      .send({ name: 'No Method', style: 'grid', zone: '7b' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/growingMethod/);
  });

  it('returns 400 when growingMethod is invalid', async () => {
    const res = await agent
      .post('/api/gardens')
      .send({ name: 'Bad Method', style: 'grid', zone: '7b', growingMethod: 'hydroponic' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/growingMethod/);
  });

  it('returns 201 with growingMethod echoed on valid create', async () => {
    const res = await agent
      .post('/api/gardens')
      .send({ name: 'Echoed Method Garden', style: 'grid', zone: '7b', growingMethod: 'square_foot' });
    expect(res.status).toBe(201);
    expect(res.body.growingMethod).toBe('square_foot');
  });

  it('returns 400 when style is mixed (retired)', async () => {
    const res = await agent
      .post('/api/gardens')
      .send({ name: 'Mixed Style', style: 'mixed', zone: '7b', growingMethod: 'raised_bed' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/style/);
  });

  it("lists only the authenticated user's gardens", async () => {
    await createUser('other-garden-user@example.com');
    const other = await loginAgent('other-garden-user@example.com');
    await other.post('/api/gardens').send({ ...BASE_GARDEN, name: 'Other Garden' });

    const res = await agent.get('/api/gardens');
    expect(res.status).toBe(200);
    expect(res.body.data.every((g: { name: string }) => g.name !== 'Other Garden')).toBe(true);
  });

  it('fetches a garden by id with an empty beds array', async () => {
    const create = await agent.post('/api/gardens').send(BASE_GARDEN);
    const res = await agent.get(`/api/gardens/${create.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(create.body.id);
    expect(Array.isArray(res.body.beds)).toBe(true);
    expect(res.body.beds).toHaveLength(0);
  });

  it("returns 404 for another user's garden", async () => {
    const other = await loginAgent('other-garden-user@example.com');
    const created = await other.post('/api/gardens').send(BASE_GARDEN);
    const res = await agent.get(`/api/gardens/${created.body.id}`);
    expect(res.status).toBe(404);
  });

  it('updates a garden name', async () => {
    const create = await agent.post('/api/gardens').send(BASE_GARDEN);
    const res = await agent
      .patch(`/api/gardens/${create.body.id}`)
      .send({ name: 'Renamed Garden' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Renamed Garden');
  });

  it('updates style', async () => {
    const create = await agent.post('/api/gardens').send(BASE_GARDEN);
    const res = await agent
      .patch(`/api/gardens/${create.body.id}`)
      .send({ style: 'freeform' });
    expect(res.status).toBe(200);
    expect(res.body.style).toBe('freeform');
  });

  it('returns 400 when patching with invalid style', async () => {
    const create = await agent.post('/api/gardens').send(BASE_GARDEN);
    const res = await agent
      .patch(`/api/gardens/${create.body.id}`)
      .send({ style: 'diagonal' });
    expect(res.status).toBe(400);
  });

  it('PATCH growingMethod to square_foot → 200 with growingMethod echoed', async () => {
    const create = await agent.post('/api/gardens').send(BASE_GARDEN);
    const res = await agent
      .patch(`/api/gardens/${create.body.id}`)
      .send({ growingMethod: 'square_foot' });
    expect(res.status).toBe(200);
    expect(res.body.growingMethod).toBe('square_foot');
  });

  it('PATCH with invalid growingMethod → 400', async () => {
    const create = await agent.post('/api/gardens').send(BASE_GARDEN);
    const res = await agent
      .patch(`/api/gardens/${create.body.id}`)
      .send({ growingMethod: 'bogus' });
    expect(res.status).toBe(400);
  });

  it('deletes a garden', async () => {
    const create = await agent.post('/api/gardens').send(BASE_GARDEN);
    const del = await agent.delete(`/api/gardens/${create.body.id}`);
    expect(del.status).toBe(204);
    const get = await agent.get(`/api/gardens/${create.body.id}`);
    expect(get.status).toBe(404);
  });
});

// ── Beds ──────────────────────────────────────────────────────────────────────

describe('Beds — nested CRUD', () => {
  let agent: ReturnType<typeof request.agent>;
  let gardenId: string;
  let gridBedId: string;
  let freeformBedId: string;

  beforeAll(async () => {
    await createUser('bed-user@example.com');
    agent = await loginAgent('bed-user@example.com');
    const res = await agent.post('/api/gardens').send({ ...BASE_GARDEN, name: 'Bed Test Garden' });
    gardenId = res.body.id;
  });

  // Test 1
  it('POST grid bed → 201, correct shape', async () => {
    const res = await agent.post(`/api/gardens/${gardenId}/beds`).send({
      type: 'grid',
      label: 'Herb Bed',
      grid: { x: 0, y: 0, cols: 4, rows: 8 },
    });
    expect(res.status).toBe(201);
    expect(res.body.grid.cols).toBe(4);
    expect(res.body.season).toBe(currentSeason());
    expect(res.body.freeform).toBeNull();
    gridBedId = res.body.id;
  });

  // Test 2
  it('POST freeform bed → 201, correct shape', async () => {
    const res = await agent.post(`/api/gardens/${gardenId}/beds`).send({
      type: 'freeform',
      freeform: { points: [0, 0, 100, 0, 100, 80, 0, 80], closed: true },
    });
    expect(res.status).toBe(201);
    expect(res.body.freeform.points).toHaveLength(8);
    expect(res.body.grid).toBeNull();
    freeformBedId = res.body.id;
  });

  // Test 3
  it('POST with type grid but missing grid → 400', async () => {
    const res = await agent.post(`/api/gardens/${gardenId}/beds`).send({ type: 'grid' });
    expect(res.status).toBe(400);
  });

  // Test 4
  it('POST with grid cols 0 → 400', async () => {
    const res = await agent.post(`/api/gardens/${gardenId}/beds`).send({
      type: 'grid',
      grid: { x: 0, y: 0, cols: 0, rows: 4 },
    });
    expect(res.status).toBe(400);
  });

  // Test 5
  it('POST with freeform points of odd length → 400', async () => {
    const res = await agent.post(`/api/gardens/${gardenId}/beds`).send({
      type: 'freeform',
      freeform: { points: [0, 0, 100], closed: true },
    });
    expect(res.status).toBe(400);
  });

  // Test 6
  it('GET beds: default season returns both; ?season=1999 → 400; ?season=2030 → 200 empty', async () => {
    const listRes = await agent.get(`/api/gardens/${gardenId}/beds`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.data.length).toBeGreaterThanOrEqual(2);

    const badRes = await agent.get(`/api/gardens/${gardenId}/beds?season=1999`);
    expect(badRes.status).toBe(400);

    const emptyRes = await agent.get(`/api/gardens/${gardenId}/beds?season=2030`);
    expect(emptyRes.status).toBe(200);
    expect(emptyRes.body.data).toHaveLength(0);
  });

  // Test 7
  it('PATCH label only → 200, label updated, geometry untouched', async () => {
    const res = await agent
      .patch(`/api/gardens/${gardenId}/beds/${gridBedId}`)
      .send({ label: 'Updated Label' });
    expect(res.status).toBe(200);
    expect(res.body.label).toBe('Updated Label');
    expect(res.body.grid).not.toBeNull();
    expect(res.body.type).toBe('grid');
  });

  // Test 8
  it('PATCH season → 400', async () => {
    const res = await agent
      .patch(`/api/gardens/${gardenId}/beds/${gridBedId}`)
      .send({ season: 2025 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/season/);
  });

  // Test 9
  it('PATCH converting grid bed to freeform → 200, type freeform, grid null', async () => {
    const res = await agent
      .patch(`/api/gardens/${gardenId}/beds/${gridBedId}`)
      .send({
        type: 'freeform',
        freeform: { points: [0, 0, 50, 0, 50, 50, 0, 50], closed: true },
      });
    expect(res.status).toBe(200);
    expect(res.body.type).toBe('freeform');
    expect(res.body.grid).toBeNull();
  });

  // Test 10
  it('PATCH geometry object mismatching current type without type field → 400', async () => {
    // freeformBedId is freeform; sending grid geometry without a type change
    const res = await agent
      .patch(`/api/gardens/${gardenId}/beds/${freeformBedId}`)
      .send({ grid: { x: 0, y: 0, cols: 2, rows: 2 } });
    expect(res.status).toBe(400);
  });

  // Test 11
  it('DELETE → 204, then GET no longer includes it', async () => {
    const del = await agent.delete(`/api/gardens/${gardenId}/beds/${freeformBedId}`);
    expect(del.status).toBe(204);

    const list = await agent.get(`/api/gardens/${gardenId}/beds`);
    expect(list.body.data.every((b: { id: string }) => b.id !== freeformBedId)).toBe(true);
  });

  // Test 12
  it('all five bed routes with no session cookie → 401', async () => {
    const results = await Promise.all([
      request(app).get(`/api/gardens/${gardenId}/beds`),
      request(app).post(`/api/gardens/${gardenId}/beds`).send({}),
      request(app).patch(`/api/gardens/${gardenId}/beds/${gridBedId}`).send({}),
      request(app).delete(`/api/gardens/${gardenId}/beds/${gridBedId}`),
      request(app).get(`/api/gardens/${gardenId}`),
    ]);
    for (const r of results) {
      expect(r.status).toBe(401);
    }
  });

  // Test 13
  it("all five bed routes against another user's garden → 404", async () => {
    await createUser('bed-intruder@example.com');
    const intruder = await loginAgent('bed-intruder@example.com');
    const results = await Promise.all([
      intruder.get(`/api/gardens/${gardenId}/beds`),
      intruder.post(`/api/gardens/${gardenId}/beds`).send({ type: 'grid', grid: { x: 0, y: 0, cols: 1, rows: 1 } }),
      intruder.patch(`/api/gardens/${gardenId}/beds/${gridBedId}`).send({ label: 'x' }),
      intruder.delete(`/api/gardens/${gardenId}/beds/${gridBedId}`),
      intruder.get(`/api/gardens/${gardenId}`),
    ]);
    for (const r of results) {
      expect(r.status).toBe(404);
    }
  });
});

// ── Id validation ─────────────────────────────────────────────────────────────

describe('Id validation', () => {
  let agent: ReturnType<typeof request.agent>;

  beforeAll(async () => {
    await createUser('id-validation@example.com');
    agent = await loginAgent('id-validation@example.com');
  });

  it('GET /api/gardens/abc → 400', async () => {
    const res = await agent.get('/api/gardens/abc');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid id');
  });

  it('GET /api/gardens/abc/beds → 400', async () => {
    const res = await agent.get('/api/gardens/abc/beds');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid id');
  });

  it('PATCH /api/gardens/1/beds/xyz → 400', async () => {
    const res = await agent.patch('/api/gardens/1/beds/xyz').send({ label: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid id');
  });

  it('GET /api/gardens/99999999 → 404 (valid numeric id, nonexistent)', async () => {
    const res = await agent.get('/api/gardens/99999999');
    expect(res.status).toBe(404);
  });
});

// ── Thumbnails ────────────────────────────────────────────────────────────────

describe('Garden thumbnails', () => {
  const BASE_URL = 'https://cdn.test.example';
  const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const png = () => Buffer.concat([PNG_SIG, Buffer.from('fake-image-data')]);
  const KEY_RE = (gardenId: string) =>
    new RegExp(`^garden-thumbnails/${gardenId}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.png$`);

  let agent: ReturnType<typeof request.agent>;
  let prevBaseUrl: string | undefined;

  async function createGarden(a: ReturnType<typeof request.agent>): Promise<string> {
    const res = await a.post('/api/gardens').send(BASE_GARDEN);
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  async function thumbnailUrl(gardenId: string): Promise<string | null> {
    const { rows } = await pool.query<{ thumbnail_url: string | null }>(
      'SELECT thumbnail_url FROM gardens WHERE id = $1',
      [gardenId],
    );
    return rows[0].thumbnail_url;
  }

  const upload = (a: ReturnType<typeof request.agent>, gardenId: string, body: Buffer = png()) =>
    a.post(`/api/gardens/${gardenId}/thumbnail`).set('Content-Type', 'image/png').send(body);

  beforeAll(async () => {
    prevBaseUrl = process.env.R2_PUBLIC_BASE_URL;
    process.env.R2_PUBLIC_BASE_URL = BASE_URL;
    await createUser('thumb-user@example.com');
    agent = await loginAgent('thumb-user@example.com');
  });

  afterAll(() => {
    if (prevBaseUrl === undefined) delete process.env.R2_PUBLIC_BASE_URL;
    else process.env.R2_PUBLIC_BASE_URL = prevBaseUrl;
  });

  beforeEach(async () => {
    vi.mocked(uploadToR2).mockClear();
    vi.mocked(deleteFromR2).mockClear();
    vi.mocked(drainSoon).mockClear();
    await pool.query('TRUNCATE r2_deletions RESTART IDENTITY');
  });

  it('account uploads to its garden → 200 and stores the URL', async () => {
    const gardenId = await createGarden(agent);
    const res = await upload(agent, gardenId);
    expect(res.status).toBe(200);
    expect(res.body.thumbnailUrl.startsWith(`${BASE_URL}/`)).toBe(true);
    const key = res.body.thumbnailUrl.slice(BASE_URL.length + 1);
    expect(key).toMatch(KEY_RE(gardenId));
    expect(await thumbnailUrl(gardenId)).toBe(res.body.thumbnailUrl);
    expect(uploadToR2).toHaveBeenCalledWith(key, expect.any(Buffer), 'image/png');
  });

  it('guest uploads to its own garden → 200', async () => {
    const guest = request.agent(app);
    await guest.post('/api/auth/guest');
    const gardenId = await createGarden(guest);
    const res = await upload(guest, gardenId);
    expect(res.status).toBe(200);
    expect(await thumbnailUrl(gardenId)).toBe(res.body.thumbnailUrl);
  });

  it("another session's garden → 404", async () => {
    const guest = request.agent(app);
    await guest.post('/api/auth/guest');
    const gardenId = await createGarden(guest);
    const res = await upload(agent, gardenId);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Garden not found');
    expect(uploadToR2).not.toHaveBeenCalled();
  });

  it('non-numeric id → 400', async () => {
    const res = await upload(agent, 'abc');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid id');
  });

  it('non-PNG bytes → 400', async () => {
    const gardenId = await createGarden(agent);
    const res = await upload(agent, gardenId, Buffer.from('GIF89a not a png at all'));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Expected a PNG image.');
    expect(uploadToR2).not.toHaveBeenCalled();
  });

  it('Content-Type application/json → 400', async () => {
    const gardenId = await createGarden(agent);
    const res = await agent
      .post(`/api/gardens/${gardenId}/thumbnail`)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ image: 'x' }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Expected a PNG image.');
  });

  it('body over 1 MB → 413', async () => {
    const gardenId = await createGarden(agent);
    const big = Buffer.concat([PNG_SIG, Buffer.alloc(1024 * 1024)]);
    const res = await upload(agent, gardenId, big);
    expect(res.status).toBe(413);
    expect(uploadToR2).not.toHaveBeenCalled();
  });

  it('second upload deletes the first object; first upload deletes nothing', async () => {
    const gardenId = await createGarden(agent);
    const first = await upload(agent, gardenId);
    expect(first.status).toBe(200);
    expect(await queued()).toEqual([]);

    const second = await upload(agent, gardenId);
    expect(second.status).toBe(200);
    expect(await queued()).toEqual([
      { bucket: 'public', path: first.body.thumbnailUrl.slice(BASE_URL.length + 1), is_prefix: false },
    ]);
    expect(drainSoon).toHaveBeenCalled();
    expect(await thumbnailUrl(gardenId)).toBe(second.body.thumbnailUrl);
  });

  it('queues the thumbnail that is current at commit, not the one read before the upload', async () => {
    const gardenId = await createGarden(agent);
    const first = await upload(agent, gardenId);
    expect(first.status).toBe(200);
    await pool.query('TRUNCATE r2_deletions RESTART IDENTITY');

    // A concurrent upload replaces the thumbnail while this one is uploading.
    const racedKey = `garden-thumbnails/${gardenId}/raced.png`;
    vi.mocked(uploadToR2).mockImplementationOnce(async (key: string) => {
      await pool.query('UPDATE gardens SET thumbnail_url = $1 WHERE id = $2', [`${BASE_URL}/${racedKey}`, gardenId]);
      return `${BASE_URL}/${key}`;
    });
    const second = await upload(agent, gardenId);
    expect(second.status).toBe(200);

    expect(await queued()).toEqual([{ bucket: 'public', path: racedKey, is_prefix: false }]);
    expect(await thumbnailUrl(gardenId)).toBe(second.body.thumbnailUrl);
  });

  it('an old thumbnail_url without this garden\'s prefix is left alone', async () => {
    const gardenId = await createGarden(agent);
    const otherGardenUrl = `${BASE_URL}/garden-thumbnails/999999/old.png`;
    await pool.query('UPDATE gardens SET thumbnail_url = $1 WHERE id = $2', [otherGardenUrl, gardenId]);
    const res = await upload(agent, gardenId);
    expect(res.status).toBe(200);

    await pool.query('UPDATE gardens SET thumbnail_url = $1 WHERE id = $2', ['https://elsewhere.example/x.png', gardenId]);
    const res2 = await upload(agent, gardenId);
    expect(res2.status).toBe(200);

    expect(await queued()).toEqual([]);
  });

  it('R2 not configured → 503 and thumbnail_url unchanged', async () => {
    const gardenId = await createGarden(agent);
    const ok = await upload(agent, gardenId);
    expect(ok.status).toBe(200);

    vi.mocked(uploadToR2).mockRejectedValueOnce(
      new Error('R2 not configured: R2_ACCOUNT_ID, ... are required.'),
    );
    const res = await upload(agent, gardenId);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('Photo storage is not configured.');
    expect(await thumbnailUrl(gardenId)).toBe(ok.body.thumbnailUrl);
  });

  it('does not change updated_at', async () => {
    const gardenId = await createGarden(agent);
    await pool.query(
      "UPDATE gardens SET updated_at = '2020-01-01T00:00:00Z' WHERE id = $1",
      [gardenId],
    );
    const res = await upload(agent, gardenId);
    expect(res.status).toBe(200);
    const { rows } = await pool.query<{ updated_at: Date }>(
      'SELECT updated_at FROM gardens WHERE id = $1',
      [gardenId],
    );
    expect(rows[0].updated_at.toISOString()).toBe('2020-01-01T00:00:00.000Z');
  });

  it('DELETE queues the thumbnail folder and every harvest folder', async () => {
    const gardenId = await createGarden(agent);
    const { rows: h } = await pool.query<{ id: number }>(
      'INSERT INTO harvest_entries (garden_id) VALUES ($1), ($1) RETURNING id',
      [gardenId],
    );
    const res = await agent.delete(`/api/gardens/${gardenId}`);
    expect(res.status).toBe(204);
    expect(await queued()).toEqual(
      expect.arrayContaining([
        { bucket: 'public', path: `garden-thumbnails/${gardenId}/`, is_prefix: true },
        { bucket: 'public', path: `harvest-photos/${h[0].id}/`, is_prefix: true },
        { bucket: 'public', path: `harvest-photos/${h[1].id}/`, is_prefix: true },
      ]),
    );
    expect(await queued()).toHaveLength(3);
    expect(drainSoon).toHaveBeenCalledWith(expect.any(Array));
  });

  it("DELETE of someone else's garden is 404 and queues nothing", async () => {
    const guest = request.agent(app);
    await guest.post('/api/auth/guest');
    const gardenId = await createGarden(guest);
    const res = await agent.delete(`/api/gardens/${gardenId}`);
    expect(res.status).toBe(404);
    expect(await queued()).toEqual([]);
  });
});

// ── Seasons and carry-forward (Phase 50) ─────────────────────────────────────

describe('Seasons and carry-forward', () => {
  const S = currentSeason();
  let agent: ReturnType<typeof request.agent>;
  let gardenId: string;
  let otherGardenId: string;

  async function insertBed(gid: string, season: number, bed: Record<string, unknown>) {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO beds (garden_id, season, type, label, grid_x, grid_y, grid_cols, grid_rows,
                         freeform_points, freeform_closed)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id::text`,
      [gid, season, bed.type, bed.label, bed.grid_x ?? null, bed.grid_y ?? null,
       bed.grid_cols ?? null, bed.grid_rows ?? null,
       bed.freeform_points ? JSON.stringify(bed.freeform_points) : null, bed.freeform_closed ?? null],
    );
    return rows[0].id;
  }

  beforeAll(async () => {
    await createUser('season-user@example.com');
    agent = await loginAgent('season-user@example.com');
    const g = await agent.post('/api/gardens').send({ ...BASE_GARDEN, name: 'Season Garden' });
    gardenId = g.body.id;

    const lastYearGrid = await insertBed(gardenId, S - 1, {
      type: 'grid', label: 'Tomatoes', grid_x: 2, grid_y: 3, grid_cols: 4, grid_rows: 6,
    });
    await insertBed(gardenId, S - 1, {
      type: 'freeform', label: 'Kidney', freeform_points: [0, 0, 50, 0, 50, 40, 0, 40],
      freeform_closed: false,
    });
    await insertBed(gardenId, S - 3, {
      type: 'grid', label: 'Old', grid_x: 0, grid_y: 0, grid_cols: 1, grid_rows: 1,
    });
    await pool.query(
      `INSERT INTO plantings (bed_id, garden_id, season, cambium_seed_id, cell_x, cell_y)
       VALUES ($1, $2, $3, 1, 0, 0)`,
      [lastYearGrid, gardenId, S - 1],
    );

    const guest = request.agent(app);
    await guest.post('/api/auth/guest');
    const og = await guest.post('/api/gardens').send({ ...BASE_GARDEN, name: 'Guest Garden' });
    otherGardenId = og.body.id;
    await insertBed(otherGardenId, S - 1, {
      type: 'grid', label: 'G', grid_x: 0, grid_y: 0, grid_cols: 1, grid_rows: 1,
    });
  });

  it('GET /:id/seasons lists only years with beds (desc) and currentSeason', async () => {
    const res = await agent.get(`/api/gardens/${gardenId}/seasons`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ currentSeason: S, layoutSeasons: [S - 1, S - 3] });
  });

  it("GET /:id/seasons for another session's garden → 404", async () => {
    const res = await agent.get(`/api/gardens/${otherGardenId}/seasons`);
    expect(res.status).toBe(404);
  });

  it('carry-forward with fromSeason >= current → 400', async () => {
    for (const fromSeason of [S, S + 1]) {
      const res = await agent.post(`/api/gardens/${gardenId}/beds/carry-forward`).send({ fromSeason });
      expect(res.status).toBe(400);
    }
  });

  it('carry-forward with missing or non-integer fromSeason → 400', async () => {
    for (const body of [{}, { fromSeason: 'abc' }, { fromSeason: S - 1.5 }, { fromSeason: 1e12 }]) {
      const res = await agent.post(`/api/gardens/${gardenId}/beds/carry-forward`).send(body);
      expect(res.status).toBe(400);
    }
  });

  it('carry-forward accepts a numeric-string fromSeason (validateSeason convention)', async () => {
    // S - 2 has no beds, so a parsed string reaches the 404 rather than a 400.
    const res = await agent
      .post(`/api/gardens/${gardenId}/beds/carry-forward`)
      .send({ fromSeason: String(S - 2) });
    expect(res.status).toBe(404);
  });

  it('carry-forward from a season with no beds → 404', async () => {
    const res = await agent
      .post(`/api/gardens/${gardenId}/beds/carry-forward`)
      .send({ fromSeason: S - 2 });
    expect(res.status).toBe(404);
  });

  it("carry-forward into another session's garden → 404", async () => {
    const res = await agent
      .post(`/api/gardens/${otherGardenId}/beds/carry-forward`)
      .send({ fromSeason: S - 1 });
    expect(res.status).toBe(404);
  });

  it('carry-forward copies geometry and labels but no plantings', async () => {
    const res = await agent
      .post(`/api/gardens/${gardenId}/beds/carry-forward`)
      .send({ fromSeason: S - 1 });
    expect(res.status).toBe(201);
    expect(res.body.data).toHaveLength(2);
    const grid = res.body.data.find((b: { type: string }) => b.type === 'grid');
    const free = res.body.data.find((b: { type: string }) => b.type === 'freeform');
    expect(grid).toMatchObject({
      gardenId, season: S, label: 'Tomatoes',
      grid: { x: 2, y: 3, cols: 4, rows: 6 }, freeform: null,
    });
    expect(free).toMatchObject({
      gardenId, season: S, label: 'Kidney', grid: null,
      freeform: { points: [0, 0, 50, 0, 50, 40, 0, 40], closed: false },
    });

    const { rows } = await pool.query<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM plantings WHERE garden_id = $1 AND season = $2',
      [gardenId, S],
    );
    expect(rows[0].count).toBe(0);

    const beds = await agent.get(`/api/gardens/${gardenId}/beds`);
    expect(beds.body.data).toHaveLength(2);

    const seasons = await agent.get(`/api/gardens/${gardenId}/seasons`);
    expect(seasons.body.layoutSeasons).toEqual([S, S - 1, S - 3]);
  });

  it('a second carry-forward → 409', async () => {
    const res = await agent
      .post(`/api/gardens/${gardenId}/beds/carry-forward`)
      .send({ fromSeason: S - 3 });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('This season already has beds.');
  });
});

// ── Auth enforcement ──────────────────────────────────────────────────────────

describe('Auth enforcement', () => {
  it('returns 401 for unauthenticated garden list', async () => {
    const res = await request(app).get('/api/gardens');
    expect(res.status).toBe(401);
  });

  it('returns 401 for unauthenticated garden creation', async () => {
    const res = await request(app).post('/api/gardens').send(BASE_GARDEN);
    expect(res.status).toBe(401);
  });

  it('returns 401 for unauthenticated bed creation', async () => {
    const res = await request(app).post('/api/gardens/1/beds').send({ type: 'grid' });
    expect(res.status).toBe(401);
  });
});

// ── Phase 54: activePlantingCount sums quantities ────────────────────────────

describe('Garden list activePlantingCount', () => {
  it('sums planting quantities for the current season', async () => {
    await createUser('count-user@example.com');
    const agent = await loginAgent('count-user@example.com');
    const g = await agent.post('/api/gardens').send({ ...BASE_GARDEN, name: 'Count Garden' });
    const b = await agent.post(`/api/gardens/${g.body.id}/beds`).send({
      type: 'grid', label: 'Count Bed', grid: { x: 0, y: 0, cols: 4, rows: 4 },
    });
    const { rows: cs } = await pool.query<{ id: number }>(
      `INSERT INTO cambium.seeds (common_name, moderation_status, source)
       VALUES ('Count Tomato', 'active', 'editorial') RETURNING id`,
    );
    await pool.query(
      `INSERT INTO plantings (bed_id, garden_id, season, cambium_seed_id, quantity, cell_x, cell_y)
       VALUES ($1, $2, $3, $4, 3, 0, 0), ($1, $2, $3, $4, 1, 1, 0)`,
      [b.body.id, g.body.id, currentSeason(), cs[0].id],
    );
    const list = await agent.get('/api/gardens');
    const found = list.body.data.find((x: { id: string }) => x.id === g.body.id);
    expect(found.activePlantingCount).toBe(4);
  });
});

// ── Text caps ────────────────────────────────────────────────────────────────

describe('Gardens — text caps', () => {
  let agent: ReturnType<typeof request.agent>;

  beforeAll(async () => {
    await createUser('garden-caps@example.com');
    agent = await loginAgent('garden-caps@example.com');
  });

  it('POST: zone, description and zoneLocationLabel pass at max and fail at max+1', async () => {
    const cases: Array<[string, number]> = [['zone', 10], ['description', 2000], ['zoneLocationLabel', 80]];
    for (const [field, max] of cases) {
      const ok = await agent.post('/api/gardens').send({ ...BASE_GARDEN, [field]: 'a'.repeat(max) });
      expect(ok.status).toBe(201);
      const res = await agent.post('/api/gardens').send({ ...BASE_GARDEN, [field]: 'a'.repeat(max + 1) });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe(`${field} must be ${max} characters or fewer`);
    }
  });

  it('POST: zone is still required', async () => {
    const res = await agent.post('/api/gardens').send({ ...BASE_GARDEN, zone: '  ' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('zone is required');
  });

  it('PATCH: capped, present-only, null clears description', async () => {
    const id = (await agent.post('/api/gardens').send({ ...BASE_GARDEN, description: 'hello' })).body.id;
    const url = `/api/gardens/${id}`;
    expect((await agent.patch(url).send({ zone: 'a'.repeat(11) })).status).toBe(400);
    expect((await agent.patch(url).send({ description: 'a'.repeat(2001) })).status).toBe(400);
    expect((await agent.patch(url).send({ zoneLocationLabel: 'a'.repeat(81) })).status).toBe(400);
    expect((await agent.patch(url).send({ zone: ' ' })).status).toBe(400);
    const ok = await agent.patch(url).send({ description: null, zone: 'a'.repeat(10) });
    expect(ok.status).toBe(200);
    expect(ok.body.description).toBeNull();
    expect(ok.body.zone).toBe('a'.repeat(10));
  });
});

// ── Row caps and geometry bounds ─────────────────────────────────────────────

async function seedGardens(ownerId: number, n: number) {
  await pool.query(
    `INSERT INTO gardens (owner_id, name, style, zone, growing_method)
     SELECT $1, 'Seeded ' || i, 'grid', '7b', 'in_ground' FROM generate_series(1, $2::int) AS i`,
    [ownerId, n],
  );
}

async function seedBeds(gardenId: string, season: number, n: number) {
  await pool.query(
    `INSERT INTO beds (garden_id, season, type, label, grid_x, grid_y, grid_cols, grid_rows)
     SELECT $1, $2, 'grid', 'Seeded ' || i, 0, 0, 1, 1 FROM generate_series(1, $3::int) AS i`,
    [gardenId, season, n],
  );
}

async function bedCount(gardenId: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    'SELECT COUNT(*)::int AS n FROM beds WHERE garden_id = $1',
    [gardenId],
  );
  return rows[0].n;
}

const GRID_BED = { type: 'grid', label: 'Capped', grid: { x: 0, y: 0, cols: 2, rows: 2 } };
const SQUARE = [0, 0, 10, 0, 10, 10, 0, 10];

describe('Gardens — row cap (50 per account)', () => {
  it('allows the 50th garden and refuses the 51st', async () => {
    const id = await createUser('garden-cap@example.com');
    const agent = await loginAgent('garden-cap@example.com');
    await seedGardens(id, 49);

    const ok = await agent.post('/api/gardens').send(BASE_GARDEN);
    expect(ok.status).toBe(201);

    const res = await agent.post('/api/gardens').send(BASE_GARDEN);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('You can have up to 50 gardens.');
  });

  it('two parallel creates at 49 → exactly one 201 and one 409', async () => {
    const id = await createUser('garden-cap-race@example.com');
    const agent = await loginAgent('garden-cap-race@example.com');
    await seedGardens(id, 49);

    const results = await Promise.all([
      agent.post('/api/gardens').send(BASE_GARDEN),
      agent.post('/api/gardens').send(BASE_GARDEN),
    ]);
    expect(results.map(r => r.status).sort()).toEqual([201, 409]);
    const { rows } = await pool.query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM gardens WHERE owner_id = $1',
      [id],
    );
    expect(rows[0].n).toBe(50);
  });

  it('guest rule still applies (one garden, 403)', async () => {
    const guest = request.agent(app);
    await guest.post('/api/auth/guest');
    expect((await guest.post('/api/gardens').send(BASE_GARDEN)).status).toBe(201);
    const res = await guest.post('/api/gardens').send(BASE_GARDEN);
    expect(res.status).toBe(403);
    expect(res.body.guest_limit).toBe(true);
  });
});

describe('Beds — row cap (200 per garden)', () => {
  const S = currentSeason();
  let agent: ReturnType<typeof request.agent>;

  beforeAll(async () => {
    await createUser('bed-cap@example.com');
    agent = await loginAgent('bed-cap@example.com');
  });

  it('allows the 200th bed (counting all seasons) and refuses the 201st', async () => {
    const gardenId = (await agent.post('/api/gardens').send(BASE_GARDEN)).body.id;
    await seedBeds(gardenId, S - 1, 100);
    await seedBeds(gardenId, S, 99);

    const ok = await agent.post(`/api/gardens/${gardenId}/beds`).send(GRID_BED);
    expect(ok.status).toBe(201);

    const res = await agent.post(`/api/gardens/${gardenId}/beds`).send({
      type: 'freeform', label: 'Over', freeform: { points: SQUARE, closed: true },
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('A garden can have up to 200 beds.');
    expect(await bedCount(gardenId)).toBe(200);
  });

  it('two parallel creates at 199 → exactly one 201 and one 409', async () => {
    const gardenId = (await agent.post('/api/gardens').send(BASE_GARDEN)).body.id;
    await seedBeds(gardenId, S, 199);

    const results = await Promise.all([
      agent.post(`/api/gardens/${gardenId}/beds`).send(GRID_BED),
      agent.post(`/api/gardens/${gardenId}/beds`).send(GRID_BED),
    ]);
    expect(results.map(r => r.status).sort()).toEqual([201, 409]);
    expect(await bedCount(gardenId)).toBe(200);
  });

  it('carry-forward that would pass 200 → 409 and copies nothing', async () => {
    const gardenId = (await agent.post('/api/gardens').send(BASE_GARDEN)).body.id;
    await seedBeds(gardenId, S - 2, 197);
    await seedBeds(gardenId, S - 1, 2);

    const res = await agent.post(`/api/gardens/${gardenId}/beds/carry-forward`).send({ fromSeason: S - 1 });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('A garden can have up to 200 beds.');
    expect(await bedCount(gardenId)).toBe(199);
  });

  it('carry-forward that lands exactly on 200 → 201', async () => {
    const gardenId = (await agent.post('/api/gardens').send(BASE_GARDEN)).body.id;
    await seedBeds(gardenId, S - 2, 196);
    await seedBeds(gardenId, S - 1, 2);

    const res = await agent.post(`/api/gardens/${gardenId}/beds/carry-forward`).send({ fromSeason: S - 1 });
    expect(res.status).toBe(201);
    expect(res.body.data).toHaveLength(2);
    expect(await bedCount(gardenId)).toBe(200);
  });
});

describe('Beds — geometry bounds', () => {
  let agent: ReturnType<typeof request.agent>;
  let gardenId: string;

  beforeAll(async () => {
    await createUser('bed-bounds@example.com');
    agent = await loginAgent('bed-bounds@example.com');
    gardenId = (await agent.post('/api/gardens').send(BASE_GARDEN)).body.id;
  });

  const post = (body: Record<string, unknown>) => agent.post(`/api/gardens/${gardenId}/beds`).send(body);

  it('grid cols/rows: 100 ok, 101 → 400', async () => {
    expect((await post({ type: 'grid', grid: { x: 0, y: 0, cols: 100, rows: 100 } })).status).toBe(201);
    const cols = await post({ type: 'grid', grid: { x: 0, y: 0, cols: 101, rows: 1 } });
    expect(cols.status).toBe(400);
    expect(cols.body.error).toBe('grid.cols must be between 1 and 100');
    const rows = await post({ type: 'grid', grid: { x: 0, y: 0, cols: 1, rows: 101 } });
    expect(rows.status).toBe(400);
    expect(rows.body.error).toBe('grid.rows must be between 1 and 100');
  });

  it('grid x/y: ±100000 ok, 100001 → 400', async () => {
    expect((await post({ type: 'grid', grid: { x: -100000, y: 100000, cols: 1, rows: 1 } })).status).toBe(201);
    for (const xy of [{ x: 100001, y: 0 }, { x: 0, y: -100001 }]) {
      const res = await post({ type: 'grid', grid: { ...xy, cols: 1, rows: 1 } });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('grid.x and grid.y must be between -100000 and 100000');
    }
  });

  it('freeform points: ±100000 ok, 1e6 → 400', async () => {
    const ok = await post({ type: 'freeform', freeform: { points: [-100000, 0, 100000, 0, 100000, 10, 0, 10], closed: true } });
    expect(ok.status).toBe(201);
    const res = await post({ type: 'freeform', freeform: { points: [0, 0, 1e6, 0, 10, 10, 0, 10], closed: true } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('freeform.points must be between -100000 and 100000');
  });

  it('PATCH applies the same bounds', async () => {
    const bed = await post({ type: 'grid', grid: { x: 0, y: 0, cols: 2, rows: 2 } });
    const url = `/api/gardens/${gardenId}/beds/${bed.body.id}`;
    expect((await agent.patch(url).send({ grid: { x: 0, y: 0, cols: 101, rows: 2 } })).status).toBe(400);
    expect((await agent.patch(url).send({ grid: { x: 100001, y: 0, cols: 2, rows: 2 } })).status).toBe(400);
    const ff = await agent.patch(url).send({ type: 'freeform', freeform: { points: [0, 0, 1e6, 0, 10, 10, 0, 10], closed: true } });
    expect(ff.status).toBe(400);
  });

  it('PATCH lets a legacy oversized grid bed move, but not grow past 100', async () => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO beds (garden_id, season, type, label, grid_x, grid_y, grid_cols, grid_rows)
       VALUES ($1, $2, 'grid', 'Legacy', 0, 0, 120, 5)
       RETURNING id::text`,
      [gardenId, new Date().getFullYear()],
    );
    const url = `/api/gardens/${gardenId}/beds/${rows[0].id}`;
    const moved = await agent.patch(url).send({ grid: { x: 7, y: 0, cols: 120, rows: 5 } });
    expect(moved.status).toBe(200);
    expect(moved.body.grid).toMatchObject({ x: 7, cols: 120 });
    const grown = await agent.patch(url).send({ grid: { x: 7, y: 0, cols: 121, rows: 5 } });
    expect(grown.status).toBe(400);
    expect(grown.body.error).toBe('grid.cols must be between 1 and 100');
    const moveFar = await agent.patch(url).send({ grid: { x: 100001, y: 0, cols: 120, rows: 5 } });
    expect(moveFar.status).toBe(400);

    const { rows: small } = await pool.query<{ id: string }>(
      `INSERT INTO beds (garden_id, season, type, label, grid_x, grid_y, grid_cols, grid_rows)
       VALUES ($1, $2, 'grid', 'Small', 0, 0, 10, 10)
       RETURNING id::text`,
      [gardenId, new Date().getFullYear()],
    );
    const widen = await agent
      .patch(`/api/gardens/${gardenId}/beds/${small[0].id}`)
      .send({ grid: { x: 0, y: 0, cols: 120, rows: 10 } });
    expect(widen.status).toBe(400);
  });
});

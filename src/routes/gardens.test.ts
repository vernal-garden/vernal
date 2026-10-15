import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { Pool } from 'pg';

vi.mock('../lib/r2', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/r2')>()),
  uploadToR2: vi.fn(async (key: string) => `${process.env.R2_PUBLIC_BASE_URL}/${key}`),
  deleteFromR2: vi.fn(async () => {}),
}));

import { uploadToR2, deleteFromR2 } from '../lib/r2';
import app from '../index';
import { currentSeason } from '../lib/season';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL must be set to run tests');

const pool = new Pool({ connectionString: url });

async function resetDb() {
  await pool.query(
    'TRUNCATE accounts, guest_sessions, gardens, beds RESTART IDENTITY CASCADE',
  );
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

  beforeEach(() => {
    vi.mocked(uploadToR2).mockClear();
    vi.mocked(deleteFromR2).mockClear();
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
    expect(deleteFromR2).not.toHaveBeenCalled();

    const second = await upload(agent, gardenId);
    expect(second.status).toBe(200);
    expect(deleteFromR2).toHaveBeenCalledTimes(1);
    expect(deleteFromR2).toHaveBeenCalledWith(first.body.thumbnailUrl.slice(BASE_URL.length + 1));
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

    expect(deleteFromR2).not.toHaveBeenCalled();
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

  it('DELETE a garden with a thumbnail → 204 and deletes its object', async () => {
    const gardenId = await createGarden(agent);
    const up = await upload(agent, gardenId);
    expect(up.status).toBe(200);

    const res = await agent.delete(`/api/gardens/${gardenId}`);
    expect(res.status).toBe(204);
    expect(deleteFromR2).toHaveBeenCalledWith(up.body.thumbnailUrl.slice(BASE_URL.length + 1));
  });

  it('DELETE a garden without a thumbnail → 204 and deletes nothing', async () => {
    const gardenId = await createGarden(agent);
    const res = await agent.delete(`/api/gardens/${gardenId}`);
    expect(res.status).toBe(204);
    expect(deleteFromR2).not.toHaveBeenCalled();
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

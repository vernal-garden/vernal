import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { Pool } from 'pg';
import app from '../index';

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
    expect(res.body.season).toBe(new Date().getFullYear());
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

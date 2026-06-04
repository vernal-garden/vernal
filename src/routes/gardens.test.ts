import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { Pool } from 'pg';
import app from '../index';

const pool = new Pool({
  connectionString: process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL,
});

async function resetDb() {
  await pool.query(
    'TRUNCATE accounts, guest_sessions, gardens, garden_beds RESTART IDENTITY CASCADE',
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

const BASE_GARDEN = { name: 'My Backyard', style: 'grid', zone: '7b' };

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

  beforeAll(async () => {
    await createUser('bed-user@example.com');
    agent = await loginAgent('bed-user@example.com');
    const res = await agent.post('/api/gardens').send({ ...BASE_GARDEN, name: 'Bed Test Garden' });
    gardenId = res.body.id;
  });

  it('creates a bed with sort_order 0', async () => {
    const res = await agent.post(`/api/gardens/${gardenId}/beds`).send({
      name: 'Raised Bed 1',
      bedType: 'raised_bed',
      widthCm: 120,
      lengthCm: 240,
    });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Raised Bed 1');
    expect(res.body.bedType).toBe('raised_bed');
    expect(res.body.widthCm).toBe(120);
    expect(res.body.sortOrder).toBe(0);
  });

  it('second bed gets sort_order 1', async () => {
    const res = await agent
      .post(`/api/gardens/${gardenId}/beds`)
      .send({ name: 'Raised Bed 2', bedType: 'raised_bed' });
    expect(res.status).toBe(201);
    expect(res.body.sortOrder).toBe(1);
  });

  it('created beds appear in GET /gardens/:id beds array', async () => {
    const res = await agent.get(`/api/gardens/${gardenId}`);
    expect(res.status).toBe(200);
    expect(res.body.beds.length).toBeGreaterThanOrEqual(2);
  });

  it('lists beds via GET /gardens/:gardenId/beds', async () => {
    const res = await agent.get(`/api/gardens/${gardenId}/beds`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('returns 400 for an invalid bed type', async () => {
    const res = await agent
      .post(`/api/gardens/${gardenId}/beds`)
      .send({ name: 'Invalid Bed', bedType: 'magic_carpet' });
    expect(res.status).toBe(400);
  });

  it('updates a bed name', async () => {
    const create = await agent
      .post(`/api/gardens/${gardenId}/beds`)
      .send({ name: 'Old Bed Name' });
    const res = await agent
      .patch(`/api/gardens/${gardenId}/beds/${create.body.id}`)
      .send({ name: 'New Bed Name' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('New Bed Name');
  });

  it('deletes a bed', async () => {
    const create = await agent
      .post(`/api/gardens/${gardenId}/beds`)
      .send({ name: 'Bed To Delete' });
    const del = await agent.delete(`/api/gardens/${gardenId}/beds/${create.body.id}`);
    expect(del.status).toBe(204);
  });

  it("returns 404 for another user's garden bed route", async () => {
    await createUser('bed-intruder@example.com');
    const intruder = await loginAgent('bed-intruder@example.com');
    const res = await intruder.get(`/api/gardens/${gardenId}/beds`);
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
    const res = await request(app).post('/api/gardens/1/beds').send({ name: 'x' });
    expect(res.status).toBe(401);
  });
});

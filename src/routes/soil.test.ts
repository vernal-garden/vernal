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
    'TRUNCATE accounts, guest_sessions RESTART IDENTITY CASCADE',
  );
}

async function createUser(
  email: string,
  tier: 'free' | 'supporter' = 'free',
): Promise<number> {
  const hash = await bcrypt.hash('Password123!', 4);
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO accounts
       (email, password_hash, zone, zone_location_label, email_verified, subscription_tier)
     VALUES ($1, $2, '7b', 'Test City', true, $3)
     RETURNING id`,
    [email, hash, tier],
  );
  return rows[0].id;
}

async function loginAgent(email: string, password = 'Password123!') {
  const agent = request.agent(app);
  await agent.post('/api/auth/guest');
  await agent.post('/api/auth/login').send({ email, password });
  return agent;
}

// Create a garden via API; returns gardenId as string.
async function createGarden(agent: ReturnType<typeof request.agent>): Promise<string> {
  const res = await agent.post('/api/gardens').send({
    name: 'Test Garden', style: 'grid', zone: '7b', growingMethod: 'organic',
  });
  return String(res.body.id);
}

// Create a bed directly in DB; returns bedId as string.
async function createBed(gardenId: string): Promise<string> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO beds (garden_id, season, type, label, grid_x, grid_y, grid_cols, grid_rows)
     VALUES ($1, 2026, 'grid', 'Test Bed', 0, 0, 4, 4)
     RETURNING id`,
    [gardenId],
  );
  return String(rows[0].id);
}

// ── Fixtures ────────────────────────────────────────────────────────────────

let supporterAgent: ReturnType<typeof request.agent>;
let freeAgent: ReturnType<typeof request.agent>;
let otherAgent: ReturnType<typeof request.agent>;
let gardenId: string;
let bedId: string;
let otherGardenId: string;
let otherBedId: string;

beforeAll(async () => {
  await resetDb();

  await createUser('soil-supporter@example.com', 'supporter');
  await createUser('soil-free@example.com', 'free');
  await createUser('soil-other@example.com', 'supporter');

  supporterAgent = await loginAgent('soil-supporter@example.com');
  freeAgent = await loginAgent('soil-free@example.com');
  otherAgent = await loginAgent('soil-other@example.com');

  gardenId = await createGarden(supporterAgent);
  bedId = await createBed(gardenId);

  otherGardenId = await createGarden(otherAgent);
  otherBedId = await createBed(otherGardenId);
});

afterAll(() => pool.end());

// ── Guest guard ──────────────────────────────────────────────────────────────

describe('guest → 401', () => {
  it('GET soil-readings rejects guest', async () => {
    const guest = request.agent(app);
    await guest.post('/api/auth/guest');
    const res = await guest.get(`/api/gardens/${gardenId}/soil-readings`);
    expect(res.status).toBe(401);
  });
});

// ── Free account guard ───────────────────────────────────────────────────────

describe('free account → 402', () => {
  it('GET returns 402 with upgrade_required', async () => {
    const res = await freeAgent.get(`/api/gardens/${gardenId}/soil-readings`);
    expect(res.status).toBe(402);
    expect(res.body.upgrade_required).toBe(true);
  });

  it('POST returns 402', async () => {
    const res = await freeAgent.post(`/api/gardens/${gardenId}/soil-readings`).send({
      bedId, testDate: '2026-01-01', ph: 6.5,
    });
    expect(res.status).toBe(402);
    expect(res.body.upgrade_required).toBe(true);
  });

  it('PATCH returns 402', async () => {
    const res = await freeAgent.patch('/api/soil-readings/1').send({ ph: 6.5 });
    expect(res.status).toBe(402);
    expect(res.body.upgrade_required).toBe(true);
  });

  it('DELETE returns 402', async () => {
    const res = await freeAgent.delete('/api/soil-readings/1');
    expect(res.status).toBe(402);
    expect(res.body.upgrade_required).toBe(true);
  });
});

// ── POST — create ────────────────────────────────────────────────────────────

let createdReadingId: string;

describe('POST /api/gardens/:gardenId/soil-readings', () => {
  it('creates a reading with all fields', async () => {
    const res = await supporterAgent.post(`/api/gardens/${gardenId}/soil-readings`).send({
      bedId,
      testDate: '2026-03-15',
      ph: 6.8,
      nitrogen: 45,
      phosphorus: 30,
      potassium: 120,
      notes: 'After compost application',
    });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.gardenId).toBe(gardenId);
    expect(res.body.bedId).toBe(bedId);
    expect(res.body.testDate).toBe('2026-03-15');
    expect(res.body.ph).toBe(6.8);
    expect(res.body.nitrogen).toBe(45);
    expect(res.body.phosphorus).toBe(30);
    expect(res.body.potassium).toBe(120);
    expect(res.body.notes).toBe('After compost application');
    createdReadingId = res.body.id;
  });

  it('creates a reading with only required fields', async () => {
    const res = await supporterAgent.post(`/api/gardens/${gardenId}/soil-readings`).send({
      bedId,
      testDate: '2026-02-10',
      ph: 7.0,
    });
    expect(res.status).toBe(201);
    expect(res.body.nitrogen).toBeNull();
    expect(res.body.phosphorus).toBeNull();
    expect(res.body.potassium).toBeNull();
    expect(res.body.notes).toBeNull();
  });

  it('400 when ph is missing', async () => {
    const res = await supporterAgent.post(`/api/gardens/${gardenId}/soil-readings`).send({
      bedId, testDate: '2026-01-01',
    });
    expect(res.status).toBe(400);
  });

  it('400 when testDate is missing', async () => {
    const res = await supporterAgent.post(`/api/gardens/${gardenId}/soil-readings`).send({
      bedId, ph: 6.5,
    });
    expect(res.status).toBe(400);
  });

  it('400 when ph is 14.1 (out of range)', async () => {
    const res = await supporterAgent.post(`/api/gardens/${gardenId}/soil-readings`).send({
      bedId, testDate: '2026-01-01', ph: 14.1,
    });
    expect(res.status).toBe(400);
  });

  it('400 when testDate format is wrong (2024/01/01)', async () => {
    const res = await supporterAgent.post(`/api/gardens/${gardenId}/soil-readings`).send({
      bedId, testDate: '2024/01/01', ph: 6.5,
    });
    expect(res.status).toBe(400);
  });

  it('400 when bedId belongs to another garden', async () => {
    const res = await supporterAgent.post(`/api/gardens/${gardenId}/soil-readings`).send({
      bedId: otherBedId, testDate: '2026-01-01', ph: 6.5,
    });
    expect(res.status).toBe(400);
  });

  it('404 when gardenId is not digits', async () => {
    const res = await supporterAgent.post('/api/gardens/abc/soil-readings').send({
      bedId, testDate: '2026-01-01', ph: 6.5,
    });
    expect(res.status).toBe(404);
  });
});

// ── GET ──────────────────────────────────────────────────────────────────────

describe('GET /api/gardens/:gardenId/soil-readings', () => {
  it('returns readings in descending order', async () => {
    const res = await supporterAgent.get(`/api/gardens/${gardenId}/soil-readings`);
    expect(res.status).toBe(200);
    expect(res.body.data).toBeInstanceOf(Array);
    // Most recent first
    const dates = res.body.data.map((r: { testDate: string }) => r.testDate);
    expect(dates[0]).toBe('2026-03-15');
    expect(dates[1]).toBe('2026-02-10');
  });

  it('ph is returned as a Number, not a string', async () => {
    const res = await supporterAgent.get(`/api/gardens/${gardenId}/soil-readings`);
    expect(typeof res.body.data[0].ph).toBe('number');
  });

  it('404 when another user accesses the garden', async () => {
    const res = await otherAgent.get(`/api/gardens/${gardenId}/soil-readings`);
    expect(res.status).toBe(404);
  });

  it('404 when gardenId is not digits', async () => {
    const res = await supporterAgent.get('/api/gardens/abc/soil-readings');
    expect(res.status).toBe(404);
  });
});

// ── PATCH ────────────────────────────────────────────────────────────────────

describe('PATCH /api/soil-readings/:id', () => {
  it('updates notes only', async () => {
    const res = await supporterAgent.patch(`/api/soil-readings/${createdReadingId}`).send({
      notes: 'Updated note',
    });
    expect(res.status).toBe(200);
    expect(res.body.notes).toBe('Updated note');
    expect(res.body.ph).toBe(6.8); // unchanged
  });

  it('does not error on missing updated_at column', async () => {
    // The soil_readings table has no updated_at — this verifies the UPDATE
    // does not reference it.
    const res = await supporterAgent.patch(`/api/soil-readings/${createdReadingId}`).send({
      ph: 6.9,
    });
    expect(res.status).toBe(200);
    expect(res.body.ph).toBe(6.9);
  });

  it('400 when body is empty', async () => {
    const res = await supporterAgent.patch(`/api/soil-readings/${createdReadingId}`).send({});
    expect(res.status).toBe(400);
  });

  it('400 when ph is out of range', async () => {
    const res = await supporterAgent.patch(`/api/soil-readings/${createdReadingId}`).send({
      ph: -0.1,
    });
    expect(res.status).toBe(400);
  });

  it('400 when testDate format is wrong', async () => {
    const res = await supporterAgent.patch(`/api/soil-readings/${createdReadingId}`).send({
      testDate: '2026/01/01',
    });
    expect(res.status).toBe(400);
  });

  it('404 when another user tries to patch', async () => {
    const res = await otherAgent.patch(`/api/soil-readings/${createdReadingId}`).send({
      notes: 'hacked',
    });
    expect(res.status).toBe(404);
  });

  it('404 when id is not digits', async () => {
    const res = await supporterAgent.patch('/api/soil-readings/abc').send({ ph: 6.5 });
    expect(res.status).toBe(404);
  });
});

// ── DELETE ───────────────────────────────────────────────────────────────────

describe('DELETE /api/soil-readings/:id', () => {
  it('404 when another user tries to delete', async () => {
    const res = await otherAgent.delete(`/api/soil-readings/${createdReadingId}`);
    expect(res.status).toBe(404);
  });

  it('204 on successful delete', async () => {
    const res = await supporterAgent.delete(`/api/soil-readings/${createdReadingId}`);
    expect(res.status).toBe(204);
  });

  it('404 after deletion', async () => {
    const res = await supporterAgent.delete(`/api/soil-readings/${createdReadingId}`);
    expect(res.status).toBe(404);
  });

  it('404 when id is not digits', async () => {
    const res = await supporterAgent.delete('/api/soil-readings/abc');
    expect(res.status).toBe(404);
  });
});

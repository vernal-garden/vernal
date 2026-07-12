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

async function createGarden(agent: ReturnType<typeof request.agent>): Promise<string> {
  const res = await agent.post('/api/gardens').send({
    name: 'Test Garden', style: 'grid', zone: '7b', growingMethod: 'in_ground',
  });
  return String(res.body.id);
}

async function createBed(gardenId: string, label = 'Test Bed'): Promise<string> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO beds (garden_id, season, type, label, grid_x, grid_y, grid_cols, grid_rows)
     VALUES ($1, 2026, 'grid', $2, 0, 0, 4, 4)
     RETURNING id`,
    [gardenId, label],
  );
  return String(rows[0].id);
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

let supporterAgent: ReturnType<typeof request.agent>;
let otherAgent:     ReturnType<typeof request.agent>;
let freeAgent:      ReturnType<typeof request.agent>;
let gardenId:       string;
let bed1Id:         string;
let bed2Id:         string;
let otherGardenId:  string;

beforeAll(async () => {
  await resetDb();

  await createUser('amend-supporter@example.com', 'supporter');
  await createUser('amend-other@example.com',     'supporter');
  await createUser('amend-free@example.com',      'free');

  supporterAgent = await loginAgent('amend-supporter@example.com');
  otherAgent     = await loginAgent('amend-other@example.com');
  freeAgent      = await loginAgent('amend-free@example.com');

  gardenId      = await createGarden(supporterAgent);
  bed1Id        = await createBed(gardenId, 'Bed A');
  bed2Id        = await createBed(gardenId, 'Bed B');
  otherGardenId = await createGarden(otherAgent);
  await createBed(otherGardenId, 'Other Bed');
});

afterAll(() => pool.end());

// ── Guest guard ───────────────────────────────────────────────────────────────

describe('guest → 401', () => {
  it('GET amendments rejects guest', async () => {
    const guest = request.agent(app);
    await guest.post('/api/auth/guest');
    const res = await guest.get(`/api/gardens/${gardenId}/amendments`);
    expect(res.status).toBe(401);
  });

  it('POST amendments rejects guest', async () => {
    const guest = request.agent(app);
    await guest.post('/api/auth/guest');
    const res = await guest.post(`/api/gardens/${gardenId}/amendments`).send({});
    expect(res.status).toBe(401);
  });

  it('PATCH amendment rejects guest', async () => {
    const guest = request.agent(app);
    await guest.post('/api/auth/guest');
    const res = await guest.patch('/api/amendments/1').send({});
    expect(res.status).toBe(401);
  });

  it('DELETE amendment rejects guest', async () => {
    const guest = request.agent(app);
    await guest.post('/api/auth/guest');
    const res = await guest.delete('/api/amendments/1');
    expect(res.status).toBe(401);
  });
});

// ── Free account guard ────────────────────────────────────────────────────────

describe('free account → 402', () => {
  it('GET returns 402 with upgrade_required', async () => {
    const res = await freeAgent.get(`/api/gardens/${gardenId}/amendments`);
    expect(res.status).toBe(402);
    expect(res.body.upgrade_required).toBe(true);
  });

  it('POST returns 402', async () => {
    const res = await freeAgent.post(`/api/gardens/${gardenId}/amendments`).send({
      bedIds: [bed1Id], applicationDate: '2026-04-01', productName: 'Test', amendmentType: 'lime',
    });
    expect(res.status).toBe(402);
    expect(res.body.upgrade_required).toBe(true);
  });

  it('PATCH returns 402', async () => {
    const res = await freeAgent.patch('/api/amendments/1').send({ productName: 'X' });
    expect(res.status).toBe(402);
    expect(res.body.upgrade_required).toBe(true);
  });

  it('DELETE returns 402', async () => {
    const res = await freeAgent.delete('/api/amendments/1');
    expect(res.status).toBe(402);
    expect(res.body.upgrade_required).toBe(true);
  });
});

// ── POST — create ─────────────────────────────────────────────────────────────

let createdLogId: string;

describe('POST /api/gardens/:gardenId/amendments', () => {
  it('201 with two bedIds; GET returns both bedIds', async () => {
    const res = await supporterAgent
      .post(`/api/gardens/${gardenId}/amendments`)
      .send({
        bedIds:          [bed1Id, bed2Id],
        applicationDate: '2026-04-01',
        productName:     'Garden Tone 3-4-4',
        amendmentType:   'fertilizer_organic',
        amount:          2.5,
        amountUnit:      'lbs',
        applicationMethod: 'broadcast',
        notes:           'Spring feeding',
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.gardenId).toBe(gardenId);
    expect(res.body.productName).toBe('Garden Tone 3-4-4');
    expect(res.body.amendmentType).toBe('fertilizer_organic');
    expect(res.body.amount).toBe(2.5);
    expect(res.body.amountUnit).toBe('lbs');
    expect(res.body.applicationMethod).toBe('broadcast');
    expect(res.body.notes).toBe('Spring feeding');
    expect(res.body.bedIds).toHaveLength(2);
    expect(res.body.bedIds).toContain(bed1Id);
    expect(res.body.bedIds).toContain(bed2Id);
    createdLogId = res.body.id;

    // GET confirms it
    const getRes = await supporterAgent.get(`/api/gardens/${gardenId}/amendments`);
    expect(getRes.status).toBe(200);
    const log = getRes.body.data.find((l: { id: string }) => l.id === createdLogId);
    expect(log).toBeDefined();
    expect(log.bedIds).toHaveLength(2);
  });

  it('400 when productName is missing', async () => {
    const res = await supporterAgent
      .post(`/api/gardens/${gardenId}/amendments`)
      .send({ bedIds: [bed1Id], applicationDate: '2026-04-01', amendmentType: 'lime' });
    expect(res.status).toBe(400);
  });

  it('400 when productName is empty string', async () => {
    const res = await supporterAgent
      .post(`/api/gardens/${gardenId}/amendments`)
      .send({ bedIds: [bed1Id], applicationDate: '2026-04-01', productName: '  ', amendmentType: 'lime' });
    expect(res.status).toBe(400);
  });

  it('400 when amendmentType is invalid', async () => {
    const res = await supporterAgent
      .post(`/api/gardens/${gardenId}/amendments`)
      .send({ bedIds: [bed1Id], applicationDate: '2026-04-01', productName: 'X', amendmentType: 'invalid_type' });
    expect(res.status).toBe(400);
  });

  it('400 when applicationDate is missing', async () => {
    const res = await supporterAgent
      .post(`/api/gardens/${gardenId}/amendments`)
      .send({ bedIds: [bed1Id], productName: 'X', amendmentType: 'lime' });
    expect(res.status).toBe(400);
  });

  it('400 when applicationDate is malformed', async () => {
    const res = await supporterAgent
      .post(`/api/gardens/${gardenId}/amendments`)
      .send({ bedIds: [bed1Id], applicationDate: '01/04/2026', productName: 'X', amendmentType: 'lime' });
    expect(res.status).toBe(400);
  });

  it('400 when bedIds is empty array', async () => {
    const res = await supporterAgent
      .post(`/api/gardens/${gardenId}/amendments`)
      .send({ bedIds: [], applicationDate: '2026-04-01', productName: 'X', amendmentType: 'lime' });
    expect(res.status).toBe(400);
  });

  it('400 when bedIds is missing', async () => {
    const res = await supporterAgent
      .post(`/api/gardens/${gardenId}/amendments`)
      .send({ applicationDate: '2026-04-01', productName: 'X', amendmentType: 'lime' });
    expect(res.status).toBe(400);
  });

  it('400 when a bedId belongs to another garden', async () => {
    // bed from otherAgent's garden
    const otherBeds = await pool.query<{ id: number }>(
      'SELECT id FROM beds WHERE garden_id = $1 LIMIT 1',
      [otherGardenId],
    );
    const foreignBedId = String(otherBeds.rows[0].id);

    const res = await supporterAgent
      .post(`/api/gardens/${gardenId}/amendments`)
      .send({
        bedIds: [bed1Id, foreignBedId],
        applicationDate: '2026-04-01',
        productName: 'X',
        amendmentType: 'lime',
      });
    expect(res.status).toBe(400);
  });

  it('404 when garden belongs to another user', async () => {
    const res = await supporterAgent
      .get(`/api/gardens/${otherGardenId}/amendments`);
    expect(res.status).toBe(404);
  });
});

// ── PATCH ─────────────────────────────────────────────────────────────────────

describe('PATCH /api/amendments/:id', () => {
  it('replaces bedIds and updates the junction', async () => {
    const res = await supporterAgent
      .patch(`/api/amendments/${createdLogId}`)
      .send({ bedIds: [bed1Id] });

    expect(res.status).toBe(200);
    expect(res.body.bedIds).toHaveLength(1);
    expect(res.body.bedIds).toContain(bed1Id);
    expect(res.body.bedIds).not.toContain(bed2Id);
  });

  it('updates scalar fields', async () => {
    const res = await supporterAgent
      .patch(`/api/amendments/${createdLogId}`)
      .send({ productName: 'Updated Product', amount: 3, amountUnit: 'kg' });

    expect(res.status).toBe(200);
    expect(res.body.productName).toBe('Updated Product');
    expect(res.body.amount).toBe(3);
    expect(res.body.amountUnit).toBe('kg');
  });

  it('400 on empty body (no fields to update)', async () => {
    const res = await supporterAgent
      .patch(`/api/amendments/${createdLogId}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('does not error due to missing updated_at column', async () => {
    // Patching notes proves the UPDATE runs without touching updated_at
    const res = await supporterAgent
      .patch(`/api/amendments/${createdLogId}`)
      .send({ notes: 'Confirmed no updated_at error' });
    expect(res.status).toBe(200);
    expect(res.body.notes).toBe('Confirmed no updated_at error');
  });

  it('404 when trying to patch another user\'s amendment', async () => {
    const res = await otherAgent
      .patch(`/api/amendments/${createdLogId}`)
      .send({ productName: 'Stolen' });
    expect(res.status).toBe(404);
  });
});

// ── DELETE ────────────────────────────────────────────────────────────────────

describe('DELETE /api/amendments/:id', () => {
  it('404 when deleting another user\'s amendment', async () => {
    const res = await otherAgent.delete(`/api/amendments/${createdLogId}`);
    expect(res.status).toBe(404);
  });

  it('204 on successful delete; junction cascades', async () => {
    const res = await supporterAgent.delete(`/api/amendments/${createdLogId}`);
    expect(res.status).toBe(204);

    // Verify junction rows also deleted
    const jRes = await pool.query(
      'SELECT * FROM amendment_log_beds WHERE amendment_log_id = $1',
      [createdLogId],
    );
    expect(jRes.rowCount).toBe(0);

    // Verify GET no longer returns it
    const getRes = await supporterAgent.get(`/api/gardens/${gardenId}/amendments`);
    expect(getRes.body.data.find((l: { id: string }) => l.id === createdLogId)).toBeUndefined();
  });
});

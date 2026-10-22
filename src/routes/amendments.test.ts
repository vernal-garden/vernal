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
  // Read-only paid data: free accounts may GET (and DELETE) their own records,
  // so a free account on someone else's garden now gets the ownership 404.
  it('GET on another account\'s garden returns 404 (not 402)', async () => {
    const res = await freeAgent.get(`/api/gardens/${gardenId}/amendments`);
    expect(res.status).toBe(404);
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

  it('DELETE of an amendment it does not own returns 404 (not 402)', async () => {
    const res = await freeAgent.delete('/api/amendments/1');
    expect(res.status).toBe(404);
  });
});

// ── Free account: read-only paid data ─────────────────────────────────────────

describe('free account — view and delete own amendments', () => {
  let ownerAgent:     ReturnType<typeof request.agent>;
  let ownerAccountId: number;
  let ownerGardenId:  string;
  let ownerBedId:     string;

  async function insertLog(accountId: number, gId: string, bId: string, productName: string) {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO amendment_logs (user_id, garden_id, application_date, product_name, amendment_type)
       VALUES ($1, $2, '2026-05-01', $3, 'lime')
       RETURNING id::text`,
      [accountId, gId, productName],
    );
    await pool.query(
      'INSERT INTO amendment_log_beds (amendment_log_id, bed_id) VALUES ($1, $2)',
      [rows[0].id, bId],
    );
    return rows[0].id;
  }

  beforeAll(async () => {
    ownerAccountId = await createUser('amend-lapsed@example.com', 'free');
    ownerAgent     = await loginAgent('amend-lapsed@example.com');
    ownerGardenId  = await createGarden(ownerAgent);
    ownerBedId     = await createBed(ownerGardenId, 'Lapsed Bed');
  });

  it('GET list → 200 and includes the amendment', async () => {
    const id = await insertLog(ownerAccountId, ownerGardenId, ownerBedId, 'Old Lime');
    const res = await ownerAgent.get(`/api/gardens/${ownerGardenId}/amendments`);
    expect(res.status).toBe(200);
    const log = res.body.data.find((l: { id: string }) => l.id === id);
    expect(log).toBeDefined();
    expect(log.bedIds).toEqual([ownerBedId]);
  });

  it('DELETE own amendment → 204 and the row is gone', async () => {
    const id = await insertLog(ownerAccountId, ownerGardenId, ownerBedId, 'To Delete');
    const res = await ownerAgent.delete(`/api/amendments/${id}`);
    expect(res.status).toBe(204);
    const { rowCount } = await pool.query('SELECT 1 FROM amendment_logs WHERE id = $1', [id]);
    expect(rowCount).toBe(0);
  });

  it('POST create → 402 upgrade_required', async () => {
    const res = await ownerAgent.post(`/api/gardens/${ownerGardenId}/amendments`).send({
      bedIds: [ownerBedId], applicationDate: '2026-05-02', productName: 'New', amendmentType: 'lime',
    });
    expect(res.status).toBe(402);
    expect(res.body.upgrade_required).toBe(true);
  });

  it('PATCH own amendment → 402 upgrade_required, row unchanged', async () => {
    const id = await insertLog(ownerAccountId, ownerGardenId, ownerBedId, 'Keep Me');
    const res = await ownerAgent.patch(`/api/amendments/${id}`).send({ productName: 'Changed' });
    expect(res.status).toBe(402);
    expect(res.body.upgrade_required).toBe(true);
    const { rows } = await pool.query<{ product_name: string }>(
      'SELECT product_name FROM amendment_logs WHERE id = $1',
      [id],
    );
    expect(rows[0].product_name).toBe('Keep Me');
  });

  it('guest → 401 on GET list', async () => {
    const guest = request.agent(app);
    await guest.post('/api/auth/guest');
    const res = await guest.get(`/api/gardens/${ownerGardenId}/amendments`);
    expect(res.status).toBe(401);
  });

  it('DELETE another account\'s amendment → 404 and the row survives', async () => {
    const { rows } = await pool.query<{ id: number }>(
      'SELECT id FROM accounts WHERE email = $1',
      ['amend-other@example.com'],
    );
    const { rows: beds } = await pool.query<{ id: number }>(
      'SELECT id FROM beds WHERE garden_id = $1 LIMIT 1',
      [otherGardenId],
    );
    const id = await insertLog(rows[0].id, otherGardenId, String(beds[0].id), 'Theirs');
    const res = await ownerAgent.delete(`/api/amendments/${id}`);
    expect(res.status).toBe(404);
    const { rowCount } = await pool.query('SELECT 1 FROM amendment_logs WHERE id = $1', [id]);
    expect(rowCount).toBe(1);
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

// ── Text caps and number parsing ─────────────────────────────────────────────

describe('amendments — limits and number parsing', () => {
  const base = () => ({
    bedIds: [bed1Id], applicationDate: '2026-05-01',
    productName: 'Compost', amendmentType: 'compost_manure',
  });
  const post = (extra: Record<string, unknown>) =>
    supporterAgent.post(`/api/gardens/${gardenId}/amendments`).send({ ...base(), ...extra });

  it('productName: 120 passes, 121 fails; blank is required', async () => {
    expect((await post({ productName: 'a'.repeat(120) })).status).toBe(201);
    const res = await post({ productName: 'a'.repeat(121) });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('productName must be 120 characters or fewer');
    const blank = await post({ productName: '  ' });
    expect(blank.status).toBe(400);
    expect(blank.body.error).toBe('productName is required');
  });

  it('amountUnit, applicationMethod and notes caps', async () => {
    expect((await post({ amountUnit: 'a'.repeat(20), applicationMethod: 'a'.repeat(60), notes: 'a'.repeat(2000) })).status).toBe(201);
    const u = await post({ amountUnit: 'a'.repeat(21) });
    expect(u.status).toBe(400);
    expect(u.body.error).toBe('amountUnit must be 20 characters or fewer');
    const m = await post({ applicationMethod: 'a'.repeat(61) });
    expect(m.status).toBe(400);
    expect(m.body.error).toBe('applicationMethod must be 60 characters or fewer');
    const n = await post({ notes: 'a'.repeat(2001) });
    expect(n.status).toBe(400);
    expect(n.body.error).toBe('notes must be 2000 characters or fewer');
  });

  it('amount: bounds and non-numeric rejected', async () => {
    expect((await post({ amount: 100000 })).status).toBe(201);
    const bad = await post({ amount: 'x' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('amount must be a number between 0 and 100000');
    expect((await post({ amount: -1 })).status).toBe(400);
    expect((await post({ amount: 100001 })).status).toBe(400);
  });

  it('applicationDate must be a real calendar date', async () => {
    const res = await post({ applicationDate: '2026-02-30' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('applicationDate must be a valid date');
  });

  it('400 (not 500) for a bedId past int4', async () => {
    const res = await post({ bedIds: ['99999999999'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bedIds must contain positive integers');
    const created = await post({});
    const patched = await supporterAgent
      .patch(`/api/amendments/${created.body.id}`)
      .send({ bedIds: ['99999999999'] });
    expect(patched.status).toBe(400);
  });

  it('201 bedIds rejected before dedupe', async () => {
    const res = await post({ bedIds: Array.from({ length: 201 }, () => bed1Id) });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bedIds can include at most 200 beds');
  });

  it('PATCH validates present fields only and null still clears', async () => {
    const created = await post({ amount: 3, notes: 'x' });
    const id = created.body.id;
    const url = `/api/amendments/${id}`;
    expect((await supporterAgent.patch(url).send({ productName: 'a'.repeat(121) })).status).toBe(400);
    expect((await supporterAgent.patch(url).send({ amount: 'x' })).status).toBe(400);
    expect((await supporterAgent.patch(url).send({ applicationDate: '2026-02-30' })).status).toBe(400);
    expect((await supporterAgent.patch(url).send({ notes: 'a'.repeat(2001) })).status).toBe(400);
    expect((await supporterAgent.patch(url).send({ bedIds: Array.from({ length: 201 }, () => bed1Id) })).status).toBe(400);
    const ok = await supporterAgent.patch(url).send({ amount: null, notes: null, amountUnit: 'a'.repeat(20) });
    expect(ok.status).toBe(200);
    expect(ok.body.amount).toBeNull();
    expect(ok.body.notes).toBeNull();
    expect(ok.body.amountUnit).toBe('a'.repeat(20));
  });
});

// ── Lock ordering (no deadlock between cap locks) ───────────────────────────

describe('amendments — concurrent with freeform plantings', () => {
  it('a freeform planting POST and an amendment POST on the same garden/bed both succeed', async () => {
    const { rows: acct } = await pool.query<{ id: number }>(
      'SELECT id FROM accounts WHERE email = $1',
      ['amend-supporter@example.com'],
    );
    const lockGardenId = await createGarden(supporterAgent);
    const { rows: bedRows } = await pool.query<{ id: string }>(
      `INSERT INTO beds (garden_id, season, type, label, freeform_points, freeform_closed)
       VALUES ($1, $2, 'freeform', 'Lock Bed', '[0,0,100,0,100,100,0,100]', true)
       RETURNING id::text`,
      [lockGardenId, new Date().getFullYear()],
    );
    const lockBedId = bedRows[0].id;
    const { rows: seedRows } = await pool.query<{ id: number }>(
      `INSERT INTO seeds (owner_id, common_name, origin, contribution_status)
       VALUES ($1, 'Lock Basil', 'user_created', 'private')
       RETURNING id`,
      [acct[0].id],
    );

    for (let i = 0; i < 8; i++) {
      const [planting, amendment] = await Promise.all([
        supporterAgent
          .post(`/api/gardens/${lockGardenId}/beds/${lockBedId}/plantings`)
          .send({ seedId: seedRows[0].id, point: { x: 10 + i, y: 10 } }),
        supporterAgent.post(`/api/gardens/${lockGardenId}/amendments`).send({
          bedIds: [lockBedId], applicationDate: '2026-05-01',
          productName: 'Compost', amendmentType: 'compost_manure',
        }),
      ]);
      expect(planting.status).toBe(201);
      expect(amendment.status).toBe(201);
    }
  });
});

// ── Row cap (1000 per garden) ────────────────────────────────────────────────

describe('amendments — row cap', () => {
  it('allows the 1000th amendment and refuses the 1001st', async () => {
    const { rows: acct } = await pool.query<{ id: number }>(
      'SELECT id FROM accounts WHERE email = $1',
      ['amend-supporter@example.com'],
    );
    const capGardenId = await createGarden(supporterAgent);
    const capBedId = await createBed(capGardenId);
    await pool.query(
      `INSERT INTO amendment_logs (user_id, garden_id, application_date, product_name, amendment_type)
       SELECT $1, $2, '2026-01-01', 'Seeded', 'other' FROM generate_series(1, 999)`,
      [acct[0].id, capGardenId],
    );
    const post = () =>
      supporterAgent.post(`/api/gardens/${capGardenId}/amendments`).send({
        bedIds: [capBedId], applicationDate: '2026-05-01',
        productName: 'Compost', amendmentType: 'compost_manure',
      });

    expect((await post()).status).toBe(201);
    const res = await post();
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('A garden can have up to 1000 amendments.');

    const { rows } = await pool.query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM amendment_logs WHERE garden_id = $1',
      [capGardenId],
    );
    expect(rows[0].n).toBe(1000);
  });
});

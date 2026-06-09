import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { Pool } from 'pg';
import app from '../index';
import * as sessionsModule from '../lib/sessions';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL must be set to run tests');

const pool = new Pool({ connectionString: url });

async function resetDb() {
  await pool.query('TRUNCATE accounts, guest_sessions RESTART IDENTITY CASCADE');
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

async function createGuestAgent() {
  const agent = request.agent(app);
  await agent.post('/api/auth/guest').expect(201);
  return agent;
}

async function registerAgent(email: string, password = 'Password123!') {
  const agent = request.agent(app);
  await agent.post('/api/auth/guest');
  await agent.post('/api/auth/register').send({ email, password }).expect(201);
  return agent;
}

const BASE_GARDEN = {
  name: 'Guest Garden',
  style: 'grid',
  zone: '6b',
  growingMethod: 'raised_bed',
};

let activeCambiumSeedId: number;

beforeEach(async () => {
  await resetDb();
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO cambium.seeds (common_name, moderation_status, source)
     VALUES ('Tomato', 'active', 'editorial') RETURNING id`,
  );
  activeCambiumSeedId = rows[0].id;
});

afterAll(() => pool.end());

// ── Test 1: Guest happy-path CRUD chain ───────────────────────────────────────

describe('Test 1: Guest full CRUD chain', () => {
  it('garden → bed → planting → patch → delete all succeed', async () => {
    const agent = await createGuestAgent();

    const gardenRes = await agent.post('/api/gardens').send(BASE_GARDEN);
    expect(gardenRes.status).toBe(201);
    const gardenId: string = gardenRes.body.id;

    const listRes = await agent.get('/api/gardens');
    expect(listRes.status).toBe(200);
    expect(listRes.body.data).toHaveLength(1);
    expect(listRes.body.data[0].id).toBe(gardenId);

    const bedRes = await agent.post(`/api/gardens/${gardenId}/beds`).send({
      type: 'grid',
      grid: { x: 0, y: 0, cols: 4, rows: 4 },
    });
    expect(bedRes.status).toBe(201);
    const bedId: string = bedRes.body.id;

    const plantRes = await agent
      .post(`/api/gardens/${gardenId}/beds/${bedId}/plantings`)
      .send({ cambiumSeedId: activeCambiumSeedId, cell: { x: 0, y: 0 } });
    expect(plantRes.status).toBe(201);
    const plantingId: string = plantRes.body.id;

    const patchRes = await agent.patch(`/api/plantings/${plantingId}`).send({ quantity: 3 });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.quantity).toBe(3);

    expect((await agent.delete(`/api/plantings/${plantingId}`)).status).toBe(204);
  });
});

// ── Test 2: Second guest garden → 403 guest_limit ────────────────────────────

describe('Test 2: Guest garden limit', () => {
  it('returns 403 with guest_limit:true on the second garden', async () => {
    const agent = await createGuestAgent();
    await agent.post('/api/gardens').send(BASE_GARDEN).expect(201);

    const res = await agent.post('/api/gardens').send({ ...BASE_GARDEN, name: 'Second' });
    expect(res.status).toBe(403);
    expect(res.body.guest_limit).toBe(true);
    expect(typeof res.body.error).toBe('string');
  });
});

// ── Test 3: Guest isolation ───────────────────────────────────────────────────

describe('Test 3: Guest A cannot see/touch Guest B garden', () => {
  it('returns 404 for cross-guest access', async () => {
    const agentA = await createGuestAgent();
    const agentB = await createGuestAgent();

    const { body } = await agentA.post('/api/gardens').send(BASE_GARDEN).expect(201);
    const gardenId: string = body.id;

    expect((await agentB.get(`/api/gardens/${gardenId}`)).status).toBe(404);
    expect((await agentB.patch(`/api/gardens/${gardenId}`).send({ name: 'X' })).status).toBe(404);
    expect((await agentB.delete(`/api/gardens/${gardenId}`)).status).toBe(404);
  });
});

// ── Test 4: Authenticated ↔ guest cross-access ────────────────────────────────

describe('Test 4: Auth/guest cross-access both ways', () => {
  it('auth user gets 404 on guest garden; guest gets 404 on auth garden', async () => {
    const guestAgent = await createGuestAgent();
    const authAgent = await registerAgent('crossaccess@example.com');

    const { body: guestBody } = await guestAgent.post('/api/gardens').send(BASE_GARDEN).expect(201);
    const { body: authBody } = await authAgent.post('/api/gardens').send(BASE_GARDEN).expect(201);

    expect((await authAgent.get(`/api/gardens/${guestBody.id}`)).status).toBe(404);
    expect((await guestAgent.get(`/api/gardens/${authBody.id}`)).status).toBe(404);
  });
});

// ── Test 5: GET /session as guest ─────────────────────────────────────────────

describe('Test 5: GET /session as guest', () => {
  it('returns isGuest:true, expiresAt, daysRemaining ≈ 30', async () => {
    const agent = await createGuestAgent();
    const res = await agent.get('/api/auth/session');
    expect(res.status).toBe(200);
    expect(res.body.data.authenticated).toBe(false);
    expect(res.body.data.isGuest).toBe(true);
    expect(res.body.data.expiresAt).toBeDefined();
    expect(res.body.data.daysRemaining).toBeGreaterThanOrEqual(29);
    expect(res.body.data.daysRemaining).toBeLessThanOrEqual(30);
  });
});

// ── Test 6: Register from guest with populated garden ─────────────────────────

describe('Test 6: Register migrates guest garden atomically', () => {
  it('migrates garden; owner_id set; guest_session_id null; included in GET /api/gardens; pendingGuestData null', async () => {
    const agent = await createGuestAgent();
    const { body: gardenBody } = await agent.post('/api/gardens').send(BASE_GARDEN).expect(201);
    const gardenId: string = gardenBody.id;

    await agent.post('/api/auth/register').send({ email: 'migrated@example.com', password: 'Password123!' }).expect(201);

    const { rows } = await pool.query<{ owner_id: number | null; guest_session_id: string | null }>(
      'SELECT owner_id, guest_session_id FROM gardens WHERE id = $1',
      [gardenId],
    );
    expect(rows[0].owner_id).not.toBeNull();
    expect(rows[0].guest_session_id).toBeNull();

    const listRes = await agent.get('/api/gardens');
    expect(listRes.status).toBe(200);
    expect(listRes.body.data.some((g: { id: string }) => g.id === gardenId)).toBe(true);

    const sessionRes = await agent.get('/api/auth/session');
    expect(sessionRes.body.data.pendingGuestData).toBeNull();
  });
});

// ── Test 7: Register atomicity — migrateGuestData failure rolls back ──────────

describe('Test 7: Register atomicity', () => {
  it('rolls back: no account created, guest session valid, garden still guest-owned', async () => {
    const agent = await createGuestAgent();
    await agent.post('/api/gardens').send(BASE_GARDEN).expect(201);

    const { rows: sessionRows } = await pool.query<{ id: string }>(
      'SELECT id FROM guest_sessions ORDER BY created_at DESC LIMIT 1',
    );
    const guestSessionId = sessionRows[0].id;

    const spy = vi
      .spyOn(sessionsModule, 'migrateGuestData')
      .mockRejectedValueOnce(new Error('forced failure'));

    const regRes = await agent
      .post('/api/auth/register')
      .send({ email: 'atomic@example.com', password: 'Password123!' });
    expect(regRes.status).toBe(500);

    spy.mockRestore();

    // Account was NOT created
    const { rows: accRows } = await pool.query(
      'SELECT id FROM accounts WHERE email = $1',
      ['atomic@example.com'],
    );
    expect(accRows).toHaveLength(0);

    // Guest session still unmigrated
    const { rows: gsRows } = await pool.query<{ migrated_at: Date | null }>(
      'SELECT migrated_at FROM guest_sessions WHERE id = $1',
      [guestSessionId],
    );
    expect(gsRows[0].migrated_at).toBeNull();

    // Garden still guest-owned
    const { rows: gardenRows } = await pool.query(
      'SELECT id FROM gardens WHERE guest_session_id = $1',
      [guestSessionId],
    );
    expect(gardenRows).toHaveLength(1);

    // Guest agent can still use the session
    expect((await agent.get('/api/gardens')).status).toBe(200);
  });
});

// ── Test 8: Login with pending garden (has plantings) ─────────────────────────

describe('Test 8: Login with pending garden that has plantings', () => {
  it('shows pendingGuestData with correct counts; garden remains guest-attached', async () => {
    await createUser('pending@example.com');
    const guestAgent = await createGuestAgent();

    const { body: gardenBody } = await guestAgent.post('/api/gardens').send(BASE_GARDEN).expect(201);
    const gardenId: string = gardenBody.id;

    const { body: bedBody } = await guestAgent
      .post(`/api/gardens/${gardenId}/beds`)
      .send({ type: 'grid', grid: { x: 0, y: 0, cols: 4, rows: 4 } })
      .expect(201);

    await guestAgent
      .post(`/api/gardens/${gardenId}/beds/${bedBody.id}/plantings`)
      .send({ cambiumSeedId: activeCambiumSeedId, cell: { x: 0, y: 0 } })
      .expect(201);

    await guestAgent
      .post('/api/auth/login')
      .send({ email: 'pending@example.com', password: 'Password123!' })
      .expect(200);

    const sessionRes = await guestAgent.get('/api/auth/session');
    expect(sessionRes.body.data.authenticated).toBe(true);
    const pending = sessionRes.body.data.pendingGuestData;
    expect(pending).not.toBeNull();
    expect(pending.gardenName).toBe('Guest Garden');
    expect(pending.bedCount).toBe(1);
    expect(pending.plantCount).toBe(1);

    const { rows } = await pool.query<{ guest_session_id: string | null }>(
      'SELECT guest_session_id FROM gardens WHERE id = $1',
      [gardenId],
    );
    expect(rows[0].guest_session_id).not.toBeNull();
  });
});

// ── Test 9a: POST /guest-data/merge ───────────────────────────────────────────

describe('Test 9a: POST /guest-data/merge', () => {
  it('moves garden to account; pendingGuestData becomes null', async () => {
    await createUser('merge@example.com');
    const guestAgent = await createGuestAgent();

    const { body: gardenBody } = await guestAgent.post('/api/gardens').send(BASE_GARDEN).expect(201);
    const gardenId: string = gardenBody.id;

    const { body: bedBody } = await guestAgent
      .post(`/api/gardens/${gardenId}/beds`)
      .send({ type: 'grid', grid: { x: 0, y: 0, cols: 2, rows: 2 } })
      .expect(201);
    await guestAgent
      .post(`/api/gardens/${gardenId}/beds/${bedBody.id}/plantings`)
      .send({ cambiumSeedId: activeCambiumSeedId, cell: { x: 0, y: 0 } })
      .expect(201);

    await guestAgent.post('/api/auth/login').send({ email: 'merge@example.com', password: 'Password123!' });

    const mergeRes = await guestAgent.post('/api/auth/guest-data/merge');
    expect(mergeRes.status).toBe(200);
    expect(mergeRes.body.data.merged).toBe(true);

    const { rows } = await pool.query<{ owner_id: number | null; guest_session_id: string | null }>(
      'SELECT owner_id, guest_session_id FROM gardens WHERE id = $1',
      [gardenId],
    );
    expect(rows[0].owner_id).not.toBeNull();
    expect(rows[0].guest_session_id).toBeNull();

    const sessionRes = await guestAgent.get('/api/auth/session');
    expect(sessionRes.body.data.pendingGuestData).toBeNull();
  });
});

// ── Test 9b: POST /guest-data/discard ─────────────────────────────────────────

describe('Test 9b: POST /guest-data/discard', () => {
  it('deletes pending guest garden and cascades beds/plantings', async () => {
    await createUser('discard@example.com');
    const guestAgent = await createGuestAgent();

    const { body: gardenBody } = await guestAgent.post('/api/gardens').send(BASE_GARDEN).expect(201);
    const gardenId: string = gardenBody.id;

    const { body: bedBody } = await guestAgent
      .post(`/api/gardens/${gardenId}/beds`)
      .send({ type: 'grid', grid: { x: 0, y: 0, cols: 2, rows: 2 } })
      .expect(201);
    await guestAgent
      .post(`/api/gardens/${gardenId}/beds/${bedBody.id}/plantings`)
      .send({ cambiumSeedId: activeCambiumSeedId, cell: { x: 0, y: 0 } })
      .expect(201);

    await guestAgent.post('/api/auth/login').send({ email: 'discard@example.com', password: 'Password123!' });

    const discardRes = await guestAgent.post('/api/auth/guest-data/discard');
    expect(discardRes.status).toBe(200);
    expect(discardRes.body.data.discarded).toBe(true);

    const { rows } = await pool.query('SELECT id FROM gardens WHERE id = $1', [gardenId]);
    expect(rows).toHaveLength(0);
  });
});

// ── Test 10: Login silent-discard — empty guest garden deleted ────────────────

describe('Test 10: Login silent-discard (no plantings)', () => {
  it('deletes empty guest garden on login; pendingGuestData is null', async () => {
    await createUser('silentdiscard@example.com');
    const guestAgent = await createGuestAgent();

    const { body: gardenBody } = await guestAgent.post('/api/gardens').send(BASE_GARDEN).expect(201);
    const gardenId: string = gardenBody.id;

    await guestAgent.post('/api/auth/login').send({ email: 'silentdiscard@example.com', password: 'Password123!' });

    const { rows } = await pool.query('SELECT id FROM gardens WHERE id = $1', [gardenId]);
    expect(rows).toHaveLength(0);

    const sessionRes = await guestAgent.get('/api/auth/session');
    expect(sessionRes.body.data.pendingGuestData).toBeNull();
  });
});

// ── Test 11: Expired guest session ────────────────────────────────────────────

describe('Test 11: Expired guest session', () => {
  it('garden → 401; GET /session → recoverable; register still migrates garden', async () => {
    const agent = await createGuestAgent();
    const { body: gardenBody } = await agent.post('/api/gardens').send(BASE_GARDEN).expect(201);
    const gardenId: string = gardenBody.id;

    // Expire the session
    const { rows: sessionRows } = await pool.query<{ id: string }>(
      'SELECT id FROM guest_sessions ORDER BY created_at DESC LIMIT 1',
    );
    const guestSessionId = sessionRows[0].id;
    await pool.query(
      "UPDATE guest_sessions SET expires_at = NOW() - INTERVAL '1 day' WHERE id = $1",
      [guestSessionId],
    );

    // Garden access rejected
    expect((await agent.get(`/api/gardens/${gardenId}`)).status).toBe(401);

    // Session endpoint returns recoverable
    const sessionRes = await agent.get('/api/auth/session');
    expect(sessionRes.body.data.guestExpired).toBe('recoverable');

    // Register still migrates the garden
    await agent
      .post('/api/auth/register')
      .send({ email: 'expired@example.com', password: 'Password123!' })
      .expect(201);

    const { rows } = await pool.query<{ owner_id: number | null; guest_session_id: string | null }>(
      'SELECT owner_id, guest_session_id FROM gardens WHERE id = $1',
      [gardenId],
    );
    expect(rows[0].owner_id).not.toBeNull();
    expect(rows[0].guest_session_id).toBeNull();
  });
});

// ── Test 12: Deleted session row → guestExpired: 'gone' ───────────────────────

describe("Test 12: Deleted session row → guestExpired: 'gone'", () => {
  it("returns guestExpired: 'gone' after session row is hard-deleted", async () => {
    const agent = await createGuestAgent();

    // Expire then delete the row
    await pool.query(
      "UPDATE guest_sessions SET expires_at = NOW() - INTERVAL '1 day' WHERE id = (SELECT id FROM guest_sessions ORDER BY created_at DESC LIMIT 1)",
    );
    await pool.query(
      'DELETE FROM guest_sessions WHERE id = (SELECT id FROM guest_sessions ORDER BY created_at DESC LIMIT 1)',
    );

    const res = await agent.get('/api/auth/session');
    expect(res.body.data.guestExpired).toBe('gone');
  });
});

// ── Test 13: /api/me as guest → 401 ──────────────────────────────────────────

describe('Test 13: /api/me requires auth — guest gets 401', () => {
  it('returns 401 for a guest session', async () => {
    const agent = await createGuestAgent();
    expect((await agent.get('/api/me')).status).toBe(401);
  });
});

// ── Test 14: Existing authenticated behavior unchanged ────────────────────────

describe('Test 14: Authenticated gardens behavior unchanged', () => {
  it('full auth CRUD works; unauthenticated request gets 401', async () => {
    const authAgent = await registerAgent('authcompat@example.com');

    const gardenRes = await authAgent.post('/api/gardens').send(BASE_GARDEN);
    expect(gardenRes.status).toBe(201);
    const gardenId: string = gardenRes.body.id;

    expect((await authAgent.get('/api/gardens')).body.data).toHaveLength(1);
    expect((await authAgent.get(`/api/gardens/${gardenId}`)).status).toBe(200);
    expect((await authAgent.patch(`/api/gardens/${gardenId}`).send({ name: 'Updated' })).status).toBe(200);
    expect((await authAgent.delete(`/api/gardens/${gardenId}`)).status).toBe(204);

    // Unauthenticated (no session at all)
    expect((await request(app).get('/api/gardens')).status).toBe(401);
  });
});

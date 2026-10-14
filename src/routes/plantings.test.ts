import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { Pool } from 'pg';
import app from '../index';
import { currentSeason } from '../lib/season';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL must be set to run tests');

const pool = new Pool({ connectionString: url });

async function resetDb() {
  await pool.query(
    'TRUNCATE accounts, guest_sessions, gardens, beds, plantings RESTART IDENTITY CASCADE',
  );
  await pool.query('TRUNCATE cambium.seeds RESTART IDENTITY CASCADE');
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

// Fixture state shared across test suites
let agent: ReturnType<typeof request.agent>;
let otherAgent: ReturnType<typeof request.agent>;
let accountId: number;
let gardenId: string;
let gridBedId: string;
let freeformBedId: string;
let personalSeedId: number;
let activeCambiumSeedId: number;
let flaggedCambiumSeedId: number;
// Planting IDs created during tests
let gridPlantingId: string;
let freeformPlantingId: string;

const CURRENT_YEAR = currentSeason();

beforeAll(async () => {
  await resetDb();

  // Create main user and another user
  accountId = await createUser('planting-user@example.com');
  await createUser('planting-other@example.com');

  agent = await loginAgent('planting-user@example.com');
  otherAgent = await loginAgent('planting-other@example.com');

  // Create garden
  const gardenRes = await agent.post('/api/gardens').send({
    name: 'Planting Test Garden',
    style: 'grid',
    zone: '7b',
    growingMethod: 'in_ground',
  });
  gardenId = gardenRes.body.id;

  // Create grid bed (4 cols × 8 rows)
  const gridBedRes = await agent.post(`/api/gardens/${gardenId}/beds`).send({
    type: 'grid',
    label: 'Grid Bed',
    grid: { x: 0, y: 0, cols: 4, rows: 8 },
  });
  gridBedId = gridBedRes.body.id;

  // Create freeform bed
  const freeformBedRes = await agent.post(`/api/gardens/${gardenId}/beds`).send({
    type: 'freeform',
    label: 'Freeform Bed',
    freeform: { points: [0, 0, 200, 0, 200, 150, 0, 150], closed: true },
  });
  freeformBedId = freeformBedRes.body.id;

  // Create personal seed (owned by main user)
  const { rows: seedRows } = await pool.query<{ id: number }>(
    `INSERT INTO seeds (owner_id, common_name, origin, contribution_status)
     VALUES ($1, 'Basil', 'user_created', 'private')
     RETURNING id`,
    [accountId],
  );
  personalSeedId = seedRows[0].id;

  // Create active and flagged cambium seeds
  const { rows: activeSeedRows } = await pool.query<{ id: number }>(
    `INSERT INTO cambium.seeds (common_name, moderation_status, source)
     VALUES ('Tomato', 'active', 'editorial')
     RETURNING id`,
  );
  activeCambiumSeedId = activeSeedRows[0].id;

  const { rows: flaggedSeedRows } = await pool.query<{ id: number }>(
    `INSERT INTO cambium.seeds (common_name, moderation_status, source)
     VALUES ('Flagged Plant', 'flagged', 'editorial')
     RETURNING id`,
  );
  flaggedCambiumSeedId = flaggedSeedRows[0].id;
});

afterAll(() => pool.end());

// ── Test 1: POST grid-bed planting with cambiumSeedId + cell ─────────────────

describe('Test 1: POST grid-bed planting with cambiumSeedId + cell', () => {
  it('returns 201, season matches bed season, point is null, growth.harvestReady is false', async () => {
    const res = await agent
      .post(`/api/gardens/${gardenId}/beds/${gridBedId}/plantings`)
      .send({ cambiumSeedId: activeCambiumSeedId, cell: { x: 1, y: 3 } });
    expect(res.status).toBe(201);
    expect(res.body.season).toBe(CURRENT_YEAR);
    expect(res.body.point).toBeNull();
    expect(res.body.growth.harvestReady).toBe(false);
    expect(res.body.cambiumSeedId).toBe(String(activeCambiumSeedId));
    expect(res.body.cell).toEqual({ x: 1, y: 3 });
    gridPlantingId = res.body.id;
  });
});

// ── Test 2: POST with seedId (personal) ──────────────────────────────────────

describe('Test 2: POST with personal seedId', () => {
  it('returns 201', async () => {
    const res = await agent
      .post(`/api/gardens/${gardenId}/beds/${gridBedId}/plantings`)
      .send({ seedId: personalSeedId, cell: { x: 0, y: 0 } });
    expect(res.status).toBe(201);
    expect(res.body.seedId).toBe(String(personalSeedId));
  });
});

// ── Test 3: POST with both / neither seedId and cambiumSeedId ────────────────

describe('Test 3: POST with both seedId and cambiumSeedId → 400; with neither → 400', () => {
  it('returns 400 when both are provided', async () => {
    const res = await agent
      .post(`/api/gardens/${gardenId}/beds/${gridBedId}/plantings`)
      .send({ seedId: personalSeedId, cambiumSeedId: activeCambiumSeedId, cell: { x: 2, y: 2 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  it('returns 400 when neither is provided', async () => {
    const res = await agent
      .post(`/api/gardens/${gardenId}/beds/${gridBedId}/plantings`)
      .send({ cell: { x: 2, y: 2 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });
});

// ── Test 4: POST with another user's seedId ───────────────────────────────────

describe('Test 4: POST with another user\'s seedId → 400', () => {
  it('returns 400 when seedId belongs to a different account', async () => {
    // personalSeedId belongs to main user; other agent tries to use it
    const res = await otherAgent
      .post(`/api/gardens`)
      .send({ name: 'Other Garden', style: 'grid', zone: '7b', growingMethod: 'in_ground' })
      .then(async (gardenRes: { body: { id: string } }) => {
        const othGardenId = gardenRes.body.id;
        const bedRes = await otherAgent
          .post(`/api/gardens/${othGardenId}/beds`)
          .send({ type: 'grid', label: 'Other Bed', grid: { x: 0, y: 0, cols: 4, rows: 4 } });
        const othBedId = bedRes.body.id;
        return otherAgent
          .post(`/api/gardens/${othGardenId}/beds/${othBedId}/plantings`)
          .send({ seedId: personalSeedId, cell: { x: 0, y: 0 } });
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/seedId not found/);
  });
});

// ── Test 5: POST with flagged cambiumSeedId → 400 ────────────────────────────

describe('Test 5: POST with flagged cambiumSeedId → 400', () => {
  it('returns 400 for flagged cambium seed', async () => {
    const res = await agent
      .post(`/api/gardens/${gardenId}/beds/${gridBedId}/plantings`)
      .send({ cambiumSeedId: flaggedCambiumSeedId, cell: { x: 2, y: 2 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cambiumSeedId not found/);
  });
});

// ── Test 6: POST cell out of bounds ──────────────────────────────────────────

describe('Test 6: POST cell out of bounds → 400', () => {
  it('returns 400 when cell.x equals grid_cols (out of bounds)', async () => {
    const res = await agent
      .post(`/api/gardens/${gardenId}/beds/${gridBedId}/plantings`)
      .send({ cambiumSeedId: activeCambiumSeedId, cell: { x: 4, y: 0 } }); // cols=4, so max x is 3
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cell\.x/);
  });
});

// ── Test 7: POST point on grid bed → 400; POST cell on freeform bed → 400 ────

describe('Test 7: POST wrong position type for bed type', () => {
  it('returns 400 when posting point to a grid bed', async () => {
    const res = await agent
      .post(`/api/gardens/${gardenId}/beds/${gridBedId}/plantings`)
      .send({ cambiumSeedId: activeCambiumSeedId, point: { x: 10, y: 20 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cell coordinates/);
  });

  it('returns 400 when posting cell to a freeform bed', async () => {
    const res = await agent
      .post(`/api/gardens/${gardenId}/beds/${freeformBedId}/plantings`)
      .send({ cambiumSeedId: activeCambiumSeedId, cell: { x: 0, y: 0 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/point coordinates/);
  });
});

// ── Test 8: POST with growthStagePct → 400 ───────────────────────────────────

describe('Test 8: POST with growthStagePct → 400', () => {
  it('returns 400 naming the nightly job when growth fields are submitted', async () => {
    const res = await agent
      .post(`/api/gardens/${gardenId}/beds/${gridBedId}/plantings`)
      .send({ cambiumSeedId: activeCambiumSeedId, cell: { x: 3, y: 3 }, growthStagePct: 50 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/nightly/);
  });
});

// ── Test 9: POST with season → 400 ───────────────────────────────────────────

describe('Test 9: POST with season → 400', () => {
  it('returns 400 when season is in the body', async () => {
    const res = await agent
      .post(`/api/gardens/${gardenId}/beds/${gridBedId}/plantings`)
      .send({ cambiumSeedId: activeCambiumSeedId, cell: { x: 3, y: 4 }, season: 2025 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/season/);
  });
});

// ── Test 10: GET garden-wide list ────────────────────────────────────────────

describe('Test 10: GET garden-wide plantings list', () => {
  let freeformPlantingForList: string;

  beforeAll(async () => {
    // Create a planting in the freeform bed for the list test
    const res = await agent
      .post(`/api/gardens/${gardenId}/beds/${freeformBedId}/plantings`)
      .send({ cambiumSeedId: activeCambiumSeedId, point: { x: 50.5, y: 75.0 } });
    freeformPlantingForList = res.body.id;
    freeformPlantingId = freeformPlantingForList;
  });

  it('returns plantings from both beds for current season', async () => {
    const res = await agent.get(`/api/gardens/${gardenId}/plantings`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(2);
    const ids = res.body.data.map((p: { id: string }) => p.id);
    expect(ids).toContain(gridPlantingId);
    expect(ids).toContain(freeformPlantingForList);
  });

  it('returns 200 with empty array for a future season', async () => {
    const res = await agent.get(`/api/gardens/${gardenId}/plantings?season=2030`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });

  it('returns 400 for invalid season (1999)', async () => {
    const res = await agent.get(`/api/gardens/${gardenId}/plantings?season=1999`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/season/);
  });
});

// ── Test 11: GET bed list includes plantingCount ──────────────────────────────

describe('Test 11: GET bed list plantingCount', () => {
  it('each bed\'s plantingCount matches its actual plantings', async () => {
    // Count plantings per bed directly
    const { rows: gridCount } = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM plantings WHERE bed_id = $1',
      [gridBedId],
    );
    const { rows: freeformCount } = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM plantings WHERE bed_id = $1',
      [freeformBedId],
    );

    const res = await agent.get(`/api/gardens/${gardenId}/beds`);
    expect(res.status).toBe(200);

    const gridBed = res.body.data.find((b: { id: string }) => b.id === gridBedId);
    const freeformBed = res.body.data.find((b: { id: string }) => b.id === freeformBedId);

    expect(gridBed.plantingCount).toBe(parseInt(gridCount[0].count, 10));
    expect(freeformBed.plantingCount).toBe(parseInt(freeformCount[0].count, 10));
  });
});

// ── Test 12: PATCH quantity + plantingDate; PATCH cell replacement ────────────

describe('Test 12: PATCH planting', () => {
  it('PATCH quantity + plantingDate → 200', async () => {
    const res = await agent
      .patch(`/api/plantings/${gridPlantingId}`)
      .send({ quantity: 5, plantingDate: '2026-03-15' });
    expect(res.status).toBe(200);
    expect(res.body.quantity).toBe(5);
    expect(res.body.plantingDate).toBe('2026-03-15');
  });

  it('PATCH cell replacement in bounds → 200', async () => {
    const res = await agent
      .patch(`/api/plantings/${gridPlantingId}`)
      .send({ cell: { x: 2, y: 5 } });
    expect(res.status).toBe(200);
    expect(res.body.cell).toEqual({ x: 2, y: 5 });
  });

  it('PATCH point on a grid-bed planting → 400', async () => {
    const res = await agent
      .patch(`/api/plantings/${gridPlantingId}`)
      .send({ point: { x: 10, y: 20 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cell coordinates/);
  });
});

// ── Test 13: PATCH immutable / rejected fields ────────────────────────────────

describe('Test 13: PATCH immutable fields', () => {
  it('PATCH seedId → 400', async () => {
    const res = await agent
      .patch(`/api/plantings/${gridPlantingId}`)
      .send({ seedId: personalSeedId });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/seedId/);
  });

  it('PATCH harvestReady → 400', async () => {
    const res = await agent
      .patch(`/api/plantings/${gridPlantingId}`)
      .send({ harvestReady: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/nightly/);
  });

  it('PATCH with empty body → 400', async () => {
    const res = await agent
      .patch(`/api/plantings/${gridPlantingId}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/No fields/);
  });
});

// ── Test 14: PATCH dismissIndicator ──────────────────────────────────────────

describe('Test 14: PATCH dismissIndicator idempotent', () => {
  it('first dismissIndicator: true → 200, indicatorDismissedAt set', async () => {
    const res = await agent
      .patch(`/api/plantings/${gridPlantingId}`)
      .send({ dismissIndicator: true });
    expect(res.status).toBe(200);
    expect(res.body.growth.indicatorDismissedAt).not.toBeNull();
  });

  it('second dismissIndicator: true → 200 (idempotent, timestamp unchanged)', async () => {
    const first = await agent
      .patch(`/api/plantings/${gridPlantingId}`)
      .send({ dismissIndicator: true });
    const firstTs = first.body.growth.indicatorDismissedAt;

    // Wait a tick so that NOW() would differ if not using COALESCE
    await new Promise((r) => setTimeout(r, 10));

    const second = await agent
      .patch(`/api/plantings/${gridPlantingId}`)
      .send({ dismissIndicator: true });
    expect(second.status).toBe(200);
    expect(second.body.growth.indicatorDismissedAt).toBe(firstTs);
  });
});

// ── Test 15: PATCH/DELETE against another user's planting → 404 ──────────────

describe('Test 15: PATCH/DELETE cross-ownership → 404', () => {
  it('other user PATCH → 404', async () => {
    const res = await otherAgent
      .patch(`/api/plantings/${gridPlantingId}`)
      .send({ quantity: 99 });
    expect(res.status).toBe(404);
  });

  it('other user DELETE → 404', async () => {
    const res = await otherAgent.delete(`/api/plantings/${gridPlantingId}`);
    expect(res.status).toBe(404);
  });
});

// ── Test 16: DELETE → 204; subsequent garden-wide GET omits it ───────────────

describe('Test 16: DELETE planting', () => {
  it('DELETE freeform planting → 204', async () => {
    const res = await agent.delete(`/api/plantings/${freeformPlantingId}`);
    expect(res.status).toBe(204);
  });

  it('subsequent garden-wide GET omits deleted planting', async () => {
    const res = await agent.get(`/api/gardens/${gardenId}/plantings`);
    expect(res.status).toBe(200);
    const ids = res.body.data.map((p: { id: string }) => p.id);
    expect(ids).not.toContain(freeformPlantingId);
  });
});

// ── Test 17: All planting routes with no session → 401 ───────────────────────

describe('Test 17: Unauthenticated requests → 401', () => {
  it('GET garden-wide plantings without session → 401', async () => {
    const res = await request(app).get(`/api/gardens/${gardenId}/plantings`);
    expect(res.status).toBe(401);
  });

  it('GET bed plantings without session → 401', async () => {
    const res = await request(app).get(`/api/gardens/${gardenId}/beds/${gridBedId}/plantings`);
    expect(res.status).toBe(401);
  });

  it('POST bed planting without session → 401', async () => {
    const res = await request(app)
      .post(`/api/gardens/${gardenId}/beds/${gridBedId}/plantings`)
      .send({ cambiumSeedId: activeCambiumSeedId, cell: { x: 0, y: 0 } });
    expect(res.status).toBe(401);
  });

  it('PATCH planting without session → 401', async () => {
    const res = await request(app)
      .patch(`/api/plantings/${gridPlantingId}`)
      .send({ quantity: 2 });
    expect(res.status).toBe(401);
  });

  it('DELETE planting without session → 401', async () => {
    const res = await request(app).delete(`/api/plantings/${gridPlantingId}`);
    expect(res.status).toBe(401);
  });
});

// ── Test 18: Router remount regression ───────────────────────────────────────

describe('Test 18: Router remount regression', () => {
  it('GET /api/catalogue/seeds with no session → 200 (no auth required)', async () => {
    const res = await request(app).get('/api/catalogue/seeds');
    expect(res.status).toBe(200);
  });

  it('GET /api/plants with no session → 404 JSON (not 401)', async () => {
    const res = await request(app).get('/api/plants');
    expect(res.status).toBe(404);
    expect(res.body.error).toBeDefined();
  });

  it('GET /api/gardens with no session → 401', async () => {
    const res = await request(app).get('/api/gardens');
    expect(res.status).toBe(401);
  });
});

// ── Test 19: Deleting a bed cascades its plantings ───────────────────────────

describe('Test 19: Bed deletion cascades plantings', () => {
  let cascadeGardenId: string;
  let cascadeBedId: string;
  let cascadePlantingId: string;

  beforeAll(async () => {
    const gardenRes = await agent.post('/api/gardens').send({
      name: 'Cascade Test Garden',
      style: 'grid',
      zone: '7b',
      growingMethod: 'in_ground',
    });
    cascadeGardenId = gardenRes.body.id;

    const bedRes = await agent.post(`/api/gardens/${cascadeGardenId}/beds`).send({
      type: 'grid',
      label: 'Cascade Bed',
      grid: { x: 0, y: 0, cols: 3, rows: 3 },
    });
    cascadeBedId = bedRes.body.id;

    const plantingRes = await agent
      .post(`/api/gardens/${cascadeGardenId}/beds/${cascadeBedId}/plantings`)
      .send({ cambiumSeedId: activeCambiumSeedId, cell: { x: 0, y: 0 } });
    cascadePlantingId = plantingRes.body.id;
  });

  it('deleting the bed cascades its plantings (direct count = 0)', async () => {
    // Verify planting exists before delete
    const { rows: before } = await pool.query(
      'SELECT id FROM plantings WHERE id = $1',
      [cascadePlantingId],
    );
    expect(before.length).toBe(1);

    // Delete the bed
    const delRes = await agent.delete(`/api/gardens/${cascadeGardenId}/beds/${cascadeBedId}`);
    expect(delRes.status).toBe(204);

    // Verify planting was cascaded
    const { rows: after } = await pool.query(
      'SELECT id FROM plantings WHERE id = $1',
      [cascadePlantingId],
    );
    expect(after.length).toBe(0);
  });
});

// ── Test 20: GET plantings includes companionSeedId and spacingInches ─────────

describe('Test 20: GET plantings includes companionSeedId and spacingInches', () => {
  let linkedSeedId: number;
  let linkedCambiumSeedWithSpacing: number;

  beforeAll(async () => {
    // Create a cambium seed with spacing
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO cambium.seeds (common_name, moderation_status, source, spacing_inches)
       VALUES ('Carrot', 'active', 'editorial', 9)
       RETURNING id`,
    );
    linkedCambiumSeedWithSpacing = rows[0].id;

    // Create a personal seed linked to that cambium seed
    const { rows: sr } = await pool.query<{ id: number }>(
      `INSERT INTO seeds (owner_id, common_name, origin, contribution_status, cambium_source_id)
       VALUES ($1, 'Linked Carrot', 'cambium_linked', 'private', $2)
       RETURNING id`,
      [accountId, linkedCambiumSeedWithSpacing],
    );
    linkedSeedId = sr[0].id;
  });

  it('garden-wide GET: each planting has companionSeedId and spacingInches keys', async () => {
    const res = await agent.get(`/api/gardens/${gardenId}/plantings`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    for (const p of res.body.data) {
      expect('companionSeedId' in p).toBe(true);
      expect('spacingInches' in p).toBe(true);
    }
  });

  it('bed GET: each planting has companionSeedId and spacingInches keys', async () => {
    const res = await agent.get(`/api/gardens/${gardenId}/beds/${gridBedId}/plantings`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    for (const p of res.body.data) {
      expect('companionSeedId' in p).toBe(true);
      expect('spacingInches' in p).toBe(true);
    }
  });

  it('cambium planting: companionSeedId equals cambiumSeedId', async () => {
    const res = await agent.get(`/api/gardens/${gardenId}/plantings`);
    const p = res.body.data.find((x: { cambiumSeedId: string | null }) => x.cambiumSeedId != null);
    expect(p).toBeDefined();
    expect(p.companionSeedId).toBe(p.cambiumSeedId);
  });

  it('personal seed with cambium_source_id: companionSeedId uses cambium source', async () => {
    // Place a planting with the linked personal seed
    const res = await agent
      .post(`/api/gardens/${gardenId}/beds/${gridBedId}/plantings`)
      .send({ seedId: linkedSeedId, cell: { x: 3, y: 7 } });
    expect(res.status).toBe(201);
    const plantingId = res.body.id;

    const listRes = await agent.get(`/api/gardens/${gardenId}/plantings`);
    const found = listRes.body.data.find((p: { id: string }) => p.id === plantingId);
    expect(found).toBeDefined();
    expect(found.companionSeedId).toBe(String(linkedCambiumSeedWithSpacing));
    expect(found.spacingInches).toBe(9);
  });

  it('personal seed without cambium link: companionSeedId is null', async () => {
    const res = await agent.get(`/api/gardens/${gardenId}/plantings`);
    const p = res.body.data.find((x: { seedId: string | null; cambiumSeedId: string | null }) =>
      x.seedId != null && x.cambiumSeedId == null
    );
    if (p) {
      // personalSeedId has no cambium_source_id → companionSeedId should be null
      expect(p.companionSeedId).toBeNull();
    }
  });
});

// ── Phase 50: growth stage fields + displayed-stage endpoint ─────────────────

describe('Phase 50: growth.stage / displayedStage / anchored', () => {
  let stagedId: string;
  let unstagedId: string;

  beforeAll(async () => {
    const a = await agent
      .post(`/api/gardens/${gardenId}/beds/${gridBedId}/plantings`)
      .send({ cambiumSeedId: activeCambiumSeedId, cell: { x: 2, y: 5 } });
    stagedId = a.body.id;
    const b = await agent
      .post(`/api/gardens/${gardenId}/beds/${gridBedId}/plantings`)
      .send({ cambiumSeedId: activeCambiumSeedId, cell: { x: 2, y: 6 } });
    unstagedId = b.body.id;
    await pool.query(
      'UPDATE plantings SET growth_stage = 3, displayed_growth_stage = 2 WHERE id = $1',
      [stagedId],
    );
  });

  it('GET list exposes stage, displayedStage and anchored', async () => {
    const res = await agent.get(`/api/gardens/${gardenId}/plantings`);
    expect(res.status).toBe(200);
    const staged = res.body.data.find((p: { id: string }) => p.id === stagedId);
    const unstaged = res.body.data.find((p: { id: string }) => p.id === unstagedId);
    expect(staged.growth).toMatchObject({ stage: 3, displayedStage: 2, anchored: true });
    expect(unstaged.growth).toMatchObject({ stage: null, displayedStage: null, anchored: false });
  });

  it('PATCH /api/plantings/:id response includes the new fields', async () => {
    const res = await agent.patch(`/api/plantings/${stagedId}`).send({ quantity: 2 });
    expect(res.status).toBe(200);
    expect(res.body.growth).toMatchObject({ stage: 3, displayedStage: 2, anchored: true });
  });

  it('rejects client-set stage / displayedStage / anchored on PATCH', async () => {
    for (const key of ['stage', 'displayedStage', 'anchored']) {
      const res = await agent.patch(`/api/plantings/${stagedId}`).send({ [key]: 1 });
      expect(res.status).toBe(400);
    }
  });
});

describe('Phase 50: PATCH /api/gardens/:gardenId/plantings/displayed-stage', () => {
  let p1: string;
  let p2: string;
  let pNull: string;
  let otherGardenId: string;
  let otherPlantingId: string;

  beforeAll(async () => {
    const mk = async (x: number, y: number) => {
      const r = await agent
        .post(`/api/gardens/${gardenId}/beds/${gridBedId}/plantings`)
        .send({ cambiumSeedId: activeCambiumSeedId, cell: { x, y } });
      return r.body.id as string;
    };
    p1 = await mk(3, 0);
    p2 = await mk(3, 1);
    pNull = await mk(3, 2);
    await pool.query(
      `UPDATE plantings SET growth_stage = 4, displayed_growth_stage = 1,
         updated_at = '2020-01-01T00:00:00Z' WHERE id = ANY($1::int[])`,
      [[p1, p2]],
    );

    const og = await otherAgent.post('/api/gardens').send({
      name: 'Other Stage Garden', style: 'grid', zone: '7b', growingMethod: 'in_ground',
    });
    otherGardenId = og.body.id;
    const ob = await otherAgent.post(`/api/gardens/${otherGardenId}/beds`).send({
      type: 'grid', label: 'B', grid: { x: 0, y: 0, cols: 2, rows: 2 },
    });
    const op = await otherAgent
      .post(`/api/gardens/${otherGardenId}/beds/${ob.body.id}/plantings`)
      .send({ cambiumSeedId: activeCambiumSeedId, cell: { x: 0, y: 0 } });
    otherPlantingId = op.body.id;
    await pool.query(
      'UPDATE plantings SET growth_stage = 5, displayed_growth_stage = 1 WHERE id = $1',
      [otherPlantingId],
    );
  });

  const stageUrl = () => `/api/gardens/${gardenId}/plantings/displayed-stage`;

  it('copies growth_stage to displayed_growth_stage for this garden only, skipping null stages', async () => {
    const res = await agent.patch(stageUrl()).send({ plantingIds: [p1, p2, pNull, otherPlantingId] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: 2 });

    const { rows } = await pool.query<{ id: string; displayed_growth_stage: number | null; updated_at: Date }>(
      'SELECT id::text, displayed_growth_stage, updated_at FROM plantings WHERE id = ANY($1::int[])',
      [[p1, p2, pNull, otherPlantingId]],
    );
    const byId = Object.fromEntries(rows.map(r => [r.id, r]));
    expect(byId[p1].displayed_growth_stage).toBe(4);
    expect(byId[p2].displayed_growth_stage).toBe(4);
    expect(byId[pNull].displayed_growth_stage).toBeNull();
    expect(byId[otherPlantingId].displayed_growth_stage).toBe(1);
    // updated_at untouched
    expect(byId[p1].updated_at.toISOString()).toBe('2020-01-01T00:00:00.000Z');
  });

  it("another session's garden → 404", async () => {
    const res = await agent
      .patch(`/api/gardens/${otherGardenId}/plantings/displayed-stage`)
      .send({ plantingIds: [otherPlantingId] });
    expect(res.status).toBe(404);
  });

  it('501 ids → 400', async () => {
    const ids = Array.from({ length: 501 }, (_, i) => String(i + 1));
    const res = await agent.patch(stageUrl()).send({ plantingIds: ids });
    expect(res.status).toBe(400);
  });

  it('500 ids → 200', async () => {
    const ids = Array.from({ length: 500 }, (_, i) => String(1_000_000 + i));
    const res = await agent.patch(stageUrl()).send({ plantingIds: ids });
    expect(res.status).toBe(200);
  });

  it('empty array → 400', async () => {
    const res = await agent.patch(stageUrl()).send({ plantingIds: [] });
    expect(res.status).toBe(400);
  });

  it('missing plantingIds → 400', async () => {
    const res = await agent.patch(stageUrl()).send({});
    expect(res.status).toBe(400);
  });

  it('non-numeric id → 400', async () => {
    for (const bad of ['abc', '1.5', '-1', 7, '1234567890123456789']) {
      const res = await agent.patch(stageUrl()).send({ plantingIds: [p1, bad] });
      expect(res.status).toBe(400);
    }
  });
});

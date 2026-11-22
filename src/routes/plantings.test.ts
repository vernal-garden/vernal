import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { Pool } from 'pg';
import app from '../index';
import { currentSeason, todayPacific } from '../lib/season';

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

// When a sowing event is marked done for a planting date: noon Pacific that day.
async function noonPacific(date: string): Promise<string> {
  const { rows } = await pool.query<{ t: Date }>(
    `SELECT ($1::date + time '12:00') AT TIME ZONE 'America/Los_Angeles' AS t`,
    [date],
  );
  return rows[0].t.toISOString();
}

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

  it('dismissing leaves the growth stage alone (no re-derive)', async () => {
    await pool.query(
      `UPDATE plantings SET growth_stage = 5, growth_stage_pct = 100, harvest_ready = true
       WHERE id = $1`,
      [gridPlantingId],
    );
    const res = await agent
      .patch(`/api/plantings/${gridPlantingId}`)
      .send({ dismissIndicator: true });
    expect(res.status).toBe(200);
    expect(res.body.growth.stage).toBe(5);
    expect(res.body.growth.stagePct).toBe(100);
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
      .send({ cambiumSeedId: activeCambiumSeedId, cell: { x: 1, y: 5 } });
    stagedId = a.body.id;
    const b = await agent
      .post(`/api/gardens/${gardenId}/beds/${gridBedId}/plantings`)
      .send({ cambiumSeedId: activeCambiumSeedId, cell: { x: 2, y: 6 } });
    unstagedId = b.body.id;
    await pool.query(
      'UPDATE plantings SET growth_stage = 3, displayed_growth_stage = 2 WHERE id = $1',
      [stagedId],
    );
    // Placement now derives a stage (Phase 70); a null stage is a legacy row.
    await pool.query(
      'UPDATE plantings SET growth_stage = NULL, growth_stage_pct = NULL WHERE id = $1',
      [unstagedId],
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
    // Placement now derives a stage (Phase 70); a null stage is a legacy row.
    await pool.query('UPDATE plantings SET growth_stage = NULL WHERE id = $1', [pNull]);

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

// ── Phase 54: one planting per grid cell, same-plant merge ───────────────────

describe('Phase 54: one planting per cell', () => {
  let bedId: string;
  let bedCounter = 0;
  const plantingsUrl = () => `/api/gardens/${gardenId}/beds/${bedId}/plantings`;

  async function freshGridBed(): Promise<string> {
    const res = await agent.post(`/api/gardens/${gardenId}/beds`).send({
      type: 'grid',
      label: `P54 Bed ${++bedCounter}`,
      grid: { x: 0, y: 0, cols: 4, rows: 4 },
    });
    return res.body.id as string;
  }

  async function linkedPersonalSeed(sourceId: number | null, name: string): Promise<number> {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO seeds (owner_id, common_name, origin, contribution_status, cambium_source_id)
       VALUES ($1, $2, $3, 'private', $4) RETURNING id`,
      [accountId, name, sourceId === null ? 'user_created' : 'cambium_imported', sourceId],
    );
    return rows[0].id;
  }

  beforeAll(async () => {
    bedId = await freshGridBed();
  });

  it('merges a same-plant placement: 4 + 12 = 16, date unchanged', async () => {
    const bed = await freshGridBed();
    const url = `/api/gardens/${gardenId}/beds/${bed}/plantings`;
    const first = await agent.post(url).send({
      cambiumSeedId: activeCambiumSeedId, cell: { x: 0, y: 0 }, quantity: 4, plantingDate: '2026-03-01',
    });
    expect(first.status).toBe(201);
    expect(first.body.merged).toBe(false);

    const second = await agent.post(url).send({
      cambiumSeedId: activeCambiumSeedId, cell: { x: 0, y: 0 }, quantity: 12, plantingDate: '2026-04-09',
    });
    expect(second.status).toBe(200);
    expect(second.body.merged).toBe(true);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.quantity).toBe(16);
    expect(second.body.plantingDate).toBe('2026-03-01');

    const list = await agent.get(url);
    const inCell = list.body.data.filter(
      (p: { cell: { x: number; y: number } | null }) => p.cell?.x === 0 && p.cell?.y === 0,
    );
    expect(inCell).toHaveLength(1);
  });

  it('clamps a merged sum at 99 and never reduces a quantity above 99', async () => {
    const bed = await freshGridBed();
    const url = `/api/gardens/${gardenId}/beds/${bed}/plantings`;
    await agent.post(url).send({ cambiumSeedId: activeCambiumSeedId, cell: { x: 0, y: 0 }, quantity: 90 });
    const clamped = await agent.post(url).send({ cambiumSeedId: activeCambiumSeedId, cell: { x: 0, y: 0 }, quantity: 20 });
    expect(clamped.status).toBe(200);
    expect(clamped.body.quantity).toBe(99);

    const big = await agent.post(url).send({ cambiumSeedId: activeCambiumSeedId, cell: { x: 1, y: 0 } });
    await agent.patch(`/api/plantings/${big.body.id}`).send({ quantity: 150 });
    const kept = await agent.post(url).send({ cambiumSeedId: activeCambiumSeedId, cell: { x: 1, y: 0 }, quantity: 5 });
    expect(kept.status).toBe(200);
    expect(kept.body.quantity).toBe(150);
  });

  it('a different plant in an occupied cell → 409 CELL_OCCUPIED, nothing inserted', async () => {
    const bed = await freshGridBed();
    const url = `/api/gardens/${gardenId}/beds/${bed}/plantings`;
    const first = await agent.post(url).send({ seedId: personalSeedId, cell: { x: 2, y: 2 } });
    expect(first.status).toBe(201);
    const res = await agent.post(url).send({ cambiumSeedId: activeCambiumSeedId, cell: { x: 2, y: 2 } });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CELL_OCCUPIED');
    expect(res.body.occupant).toEqual({ id: first.body.id, commonName: 'Basil' });
    const list = await agent.get(url);
    expect(list.body.data).toHaveLength(1);
  });

  it('linked personal seed merges into a cell holding its Cambium seed', async () => {
    const bed = await freshGridBed();
    const url = `/api/gardens/${gardenId}/beds/${bed}/plantings`;
    const linked = await linkedPersonalSeed(activeCambiumSeedId, 'My Tomato');
    const first = await agent.post(url).send({ cambiumSeedId: activeCambiumSeedId, cell: { x: 0, y: 1 }, quantity: 2 });
    const res = await agent.post(url).send({ seedId: linked, cell: { x: 0, y: 1 }, quantity: 3 });
    expect(res.status).toBe(200);
    expect(res.body.merged).toBe(true);
    expect(res.body.id).toBe(first.body.id);
    expect(res.body.quantity).toBe(5);
    expect(res.body.cambiumSeedId).toBe(String(activeCambiumSeedId));
    expect(res.body.seedId).toBeNull();
  });

  it('Cambium seed merges into a cell holding its linked personal seed', async () => {
    const bed = await freshGridBed();
    const url = `/api/gardens/${gardenId}/beds/${bed}/plantings`;
    const linked = await linkedPersonalSeed(activeCambiumSeedId, 'My Tomato 2');
    const first = await agent.post(url).send({ seedId: linked, cell: { x: 0, y: 1 }, quantity: 2 });
    const res = await agent.post(url).send({ cambiumSeedId: activeCambiumSeedId, cell: { x: 0, y: 1 }, quantity: 3 });
    expect(res.status).toBe(200);
    expect(res.body.merged).toBe(true);
    expect(res.body.id).toBe(first.body.id);
    expect(res.body.quantity).toBe(5);
    expect(res.body.seedId).toBe(String(linked));
  });

  it('user-created personal seed does not merge into a Cambium planting → 409', async () => {
    const bed = await freshGridBed();
    const url = `/api/gardens/${gardenId}/beds/${bed}/plantings`;
    await agent.post(url).send({ cambiumSeedId: activeCambiumSeedId, cell: { x: 3, y: 3 } });
    const res = await agent.post(url).send({ seedId: personalSeedId, cell: { x: 3, y: 3 } });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CELL_OCCUPIED');
    expect(res.body.occupant.commonName).toBe('Tomato');
  });

  it('same user-created personal seed twice in one cell merges and sums', async () => {
    const bed = await freshGridBed();
    const url = `/api/gardens/${gardenId}/beds/${bed}/plantings`;
    const first = await agent.post(url).send({ seedId: personalSeedId, cell: { x: 2, y: 3 }, quantity: 2 });
    const res = await agent.post(url).send({ seedId: personalSeedId, cell: { x: 2, y: 3 }, quantity: 5 });
    expect(res.status).toBe(200);
    expect(res.body.merged).toBe(true);
    expect(res.body.id).toBe(first.body.id);
    expect(res.body.quantity).toBe(7);
  });

  it('PATCH cell onto another planting → 409; onto its own cell → 200', async () => {
    const bed = await freshGridBed();
    const url = `/api/gardens/${gardenId}/beds/${bed}/plantings`;
    const a = await agent.post(url).send({ cambiumSeedId: activeCambiumSeedId, cell: { x: 0, y: 0 } });
    const b = await agent.post(url).send({ seedId: personalSeedId, cell: { x: 1, y: 0 } });
    const blocked = await agent.patch(`/api/plantings/${b.body.id}`).send({ cell: { x: 0, y: 0 } });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('CELL_OCCUPIED');
    expect(blocked.body.occupant.id).toBe(a.body.id);
    const same = await agent.patch(`/api/plantings/${b.body.id}`).send({ cell: { x: 1, y: 0 } });
    expect(same.status).toBe(200);
    expect(same.body.cell).toEqual({ x: 1, y: 0 });
  });

  it('freeform beds still allow several plantings at one point', async () => {
    const res = await agent.post(`/api/gardens/${gardenId}/beds`).send({
      type: 'freeform',
      label: 'P54 Freeform',
      freeform: { points: [0, 0, 200, 0, 200, 150, 0, 150], closed: true },
    });
    const url = `/api/gardens/${gardenId}/beds/${res.body.id}/plantings`;
    const body = { cambiumSeedId: activeCambiumSeedId, point: { x: 10, y: 10 } };
    const a = await agent.post(url).send(body);
    const b = await agent.post(url).send(body);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.id).not.toBe(b.body.id);
    const list = await agent.get(url);
    expect(list.body.data).toHaveLength(2);
  });

  it('the unique index rejects a second planting in one cell (23505)', async () => {
    await agent.post(plantingsUrl()).send({ cambiumSeedId: activeCambiumSeedId, cell: { x: 1, y: 1 } });
    await expect(
      pool.query(
        `INSERT INTO plantings (bed_id, garden_id, season, cambium_seed_id, cell_x, cell_y)
         VALUES ($1, $2, $3, $4, 1, 1)`,
        [bedId, gardenId, CURRENT_YEAR, activeCambiumSeedId],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });
});

// ── Row cap (1000 per freeform bed) and point bounds ─────────────────────────

describe('Freeform bed planting cap and point bounds', () => {
  async function newFreeformBed(): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO beds (garden_id, season, type, label, freeform_points, freeform_closed)
       VALUES ($1, $2, 'freeform', 'Cap Bed', '[0,0,100,0,100,100,0,100]', true)
       RETURNING id::text`,
      [gardenId, CURRENT_YEAR],
    );
    return rows[0].id;
  }

  async function seedPlantings(bedId: string, n: number) {
    await pool.query(
      `INSERT INTO plantings (bed_id, garden_id, season, cambium_seed_id, point_x, point_y)
       SELECT $1, $2, $3, $4, i, i FROM generate_series(1, $5::int) AS i`,
      [bedId, gardenId, CURRENT_YEAR, activeCambiumSeedId, n],
    );
  }

  async function plantingCount(bedId: string): Promise<number> {
    const { rows } = await pool.query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM plantings WHERE bed_id = $1',
      [bedId],
    );
    return rows[0].n;
  }

  const plant = (bedId: string, point: Record<string, unknown> = { x: 5, y: 5 }) =>
    agent
      .post(`/api/gardens/${gardenId}/beds/${bedId}/plantings`)
      .send({ cambiumSeedId: activeCambiumSeedId, point });

  it('allows the 1000th planting and refuses the 1001st', async () => {
    const bedId = await newFreeformBed();
    await seedPlantings(bedId, 999);
    expect((await plant(bedId)).status).toBe(201);
    const res = await plant(bedId);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('A bed can have up to 1000 plantings.');
    expect(await plantingCount(bedId)).toBe(1000);
  });

  it('two parallel creates at 999 → exactly one 201 and one 409', async () => {
    const bedId = await newFreeformBed();
    await seedPlantings(bedId, 999);
    const results = await Promise.all([plant(bedId), plant(bedId)]);
    expect(results.map(r => r.status).sort()).toEqual([201, 409]);
    expect(await plantingCount(bedId)).toBe(1000);
  });

  it('point coordinates: ±100000 ok, beyond → 400 (POST and PATCH)', async () => {
    const bedId = await newFreeformBed();
    const ok = await plant(bedId, { x: -100000, y: 100000 });
    expect(ok.status).toBe(201);
    for (const point of [{ x: 100001, y: 0 }, { x: 0, y: -1e6 }]) {
      const res = await plant(bedId, point);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('point.x and point.y must be between -100000 and 100000');
    }
    const patch = await agent.patch(`/api/plantings/${ok.body.id}`).send({ point: { x: 1e6, y: 0 } });
    expect(patch.status).toBe(400);
    expect(patch.body.error).toBe('point.x and point.y must be between -100000 and 100000');
  });
});

// ── Phase 69: illustrationKey, Cambium seed first, then the personal seed ───

describe('Phase 69: GET plantings includes illustrationKey', () => {
  let bedId: string;
  const ids: Record<'cambium' | 'linked' | 'plain' | 'unkeyed' | 'own' | 'override', string> = {
    cambium: '', linked: '', plain: '', unkeyed: '', own: '', override: '',
  };

  beforeAll(async () => {
    const bedRes = await agent.post(`/api/gardens/${gardenId}/beds`).send({
      type: 'grid',
      label: 'P69 Art Bed',
      grid: { x: 0, y: 0, cols: 4, rows: 4 },
    });
    bedId = bedRes.body.id;

    const { rows: keyed } = await pool.query<{ id: number }>(
      `INSERT INTO cambium.seeds (common_name, moderation_status, source, illustration_key)
       VALUES ('P69 Tomato', 'active', 'editorial', 'tomato'),
              ('P69 Carrot', 'active', 'editorial', 'carrot'),
              ('P69 Unkeyed', 'active', 'editorial', NULL)
       RETURNING id`,
    );
    const [tomatoId, carrotId, unkeyedId] = keyed.map(r => r.id);

    // Personal copy of the carrot with no key of its own: the key comes from Cambium.
    const { rows: linked } = await pool.query<{ id: number }>(
      `INSERT INTO seeds (owner_id, common_name, origin, contribution_status, cambium_source_id)
       VALUES ($1, 'P69 Linked Carrot', 'cambium_imported', 'private', $2)
       RETURNING id`,
      [accountId, carrotId],
    );

    // A personal seed with its own key and no Cambium link, and a linked copy
    // whose own key differs from Cambium's (Cambium wins).
    const { rows: keyedPersonal } = await pool.query<{ id: number }>(
      `INSERT INTO seeds (owner_id, common_name, origin, contribution_status, cambium_source_id, illustration_key)
       VALUES ($1, 'P69 Own Pea', 'user_created', 'private', NULL, 'pea'),
              ($1, 'P69 Override Carrot', 'cambium_imported', 'private', $2, 'tomato')
       RETURNING id`,
      [accountId, carrotId],
    );

    const url = `/api/gardens/${gardenId}/beds/${bedId}/plantings`;
    const place = async (body: Record<string, unknown>) => {
      const res = await agent.post(url).send(body);
      expect(res.status).toBe(201);
      return res.body.id as string;
    };
    ids.cambium = await place({ cambiumSeedId: tomatoId, cell: { x: 0, y: 0 } });
    ids.linked = await place({ seedId: linked[0].id, cell: { x: 1, y: 0 } });
    ids.plain = await place({ seedId: personalSeedId, cell: { x: 2, y: 0 } });
    ids.unkeyed = await place({ cambiumSeedId: unkeyedId, cell: { x: 3, y: 0 } });
    ids.own = await place({ seedId: keyedPersonal[0].id, cell: { x: 0, y: 1 } });
    ids.override = await place({ seedId: keyedPersonal[1].id, cell: { x: 1, y: 1 } });
  });

  async function keysById(path: string): Promise<Map<string, unknown>> {
    const res = await agent.get(path);
    expect(res.status).toBe(200);
    return new Map(
      res.body.data.map((p: { id: string; illustrationKey: unknown }) => [p.id, p.illustrationKey]),
    );
  }

  it('garden-wide GET: cambium planting gets the Cambium key', async () => {
    const keys = await keysById(`/api/gardens/${gardenId}/plantings`);
    expect(keys.get(ids.cambium)).toBe('tomato');
  });

  it('garden-wide GET: personal seed with cambium_source_id gets the source key', async () => {
    const keys = await keysById(`/api/gardens/${gardenId}/plantings`);
    expect(keys.get(ids.linked)).toBe('carrot');
  });

  it('garden-wide GET: illustrationKey is null with no Cambium link or no key', async () => {
    const keys = await keysById(`/api/gardens/${gardenId}/plantings`);
    expect(keys.has(ids.plain)).toBe(true);
    expect(keys.get(ids.plain)).toBeNull();
    expect(keys.has(ids.unkeyed)).toBe(true);
    expect(keys.get(ids.unkeyed)).toBeNull();
  });

  it('garden-wide GET: personal seed with no Cambium link falls back to its own key', async () => {
    const keys = await keysById(`/api/gardens/${gardenId}/plantings`);
    expect(keys.get(ids.own)).toBe('pea');
  });

  it('garden-wide GET: the Cambium key wins over the personal seed key', async () => {
    const keys = await keysById(`/api/gardens/${gardenId}/plantings`);
    expect(keys.get(ids.override)).toBe('carrot');
  });

  it('bed GET returns the same illustrationKey values', async () => {
    const keys = await keysById(`/api/gardens/${gardenId}/beds/${bedId}/plantings`);
    expect(keys.get(ids.cambium)).toBe('tomato');
    expect(keys.get(ids.linked)).toBe('carrot');
    expect(keys.get(ids.plain)).toBeNull();
    expect(keys.get(ids.unkeyed)).toBeNull();
    expect(keys.get(ids.own)).toBe('pea');
    expect(keys.get(ids.override)).toBe('carrot');
  });

  it('PATCH response includes illustrationKey', async () => {
    const res = await agent.patch(`/api/plantings/${ids.linked}`).send({ quantity: 2 });
    expect(res.status).toBe(200);
    expect(res.body.illustrationKey).toBe('carrot');
  });
});

// ── Phase 70: placing a plant sows it ────────────────────────────────────────

describe('Phase 70: growth from placement', () => {
  // Its own account, so these writes don't run into the main agent's write limit.
  let p70Agent: ReturnType<typeof request.agent>;
  let p70GardenId: string;
  let bedId: string;
  let seedCounter = 0;
  const url = () => `/api/gardens/${p70GardenId}/beds/${bedId}/plantings`;

  // A fresh Cambium seed per test, so each has its own sowing event.
  async function timedSeed(maturityDays: number | null = 65): Promise<number> {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO cambium.seeds (common_name, moderation_status, source, maturity_days_min, maturity_days_max)
       VALUES ($1, 'active', 'editorial', $2, $2) RETURNING id`,
      [`P70 Plant ${++seedCounter}`, maturityDays],
    );
    return rows[0].id;
  }

  // The Pacific date n days before today, as YYYY-MM-DD.
  async function daysAgo(n: number): Promise<string> {
    const { rows } = await pool.query<{ d: string }>(
      `SELECT ((NOW() AT TIME ZONE 'America/Los_Angeles')::date - $1::int)::text AS d`,
      [n],
    );
    return rows[0].d;
  }

  async function sowingEvents(cambiumSeedId: number) {
    const { rows } = await pool.query<{ id: string; planting_id: string | null; marked_done_at: Date | null }>(
      `SELECT id::text, planting_id::text, marked_done_at FROM sowing_events
       WHERE garden_id = $1 AND cambium_seed_id = $2 ORDER BY id`,
      [p70GardenId, cambiumSeedId],
    );
    return rows;
  }

  beforeAll(async () => {
    await createUser('planting-p70@example.com');
    p70Agent = await loginAgent('planting-p70@example.com');
    const garden = await p70Agent.post('/api/gardens').send({
      name: 'P70 Garden', style: 'grid', zone: '7b', growingMethod: 'in_ground',
    });
    p70GardenId = garden.body.id;
    const res = await p70Agent.post(`/api/gardens/${p70GardenId}/beds`).send({
      type: 'grid',
      label: 'P70 Bed',
      grid: { x: 0, y: 0, cols: 4, rows: 8 },
    });
    bedId = res.body.id;
  });

  it('POST without a date stores today (Pacific) and returns stage 1', async () => {
    const seed = await timedSeed(60);
    const res = await p70Agent.post(url()).send({ cambiumSeedId: seed, cell: { x: 0, y: 0 } });
    expect(res.status).toBe(201);
    expect(res.body.plantingDate).toBe(todayPacific());
    expect(res.body.startMethod).toBe('sown');
    expect(res.body.growth.stage).toBe(1);
  });

  it('POST transplanted returns stage 2', async () => {
    const seed = await timedSeed(60);
    const res = await p70Agent.post(url()).send({
      cambiumSeedId: seed, cell: { x: 1, y: 0 }, startMethod: 'transplanted',
    });
    expect(res.status).toBe(201);
    expect(res.body.startMethod).toBe('transplanted');
    expect(res.body.growth.stage).toBe(2);
  });

  it('POST with a bad startMethod → 400; with a null plantingDate → 400', async () => {
    const seed = await timedSeed();
    const bad = await p70Agent.post(url()).send({ cambiumSeedId: seed, cell: { x: 2, y: 0 }, startMethod: 'cloned' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("startMethod must be 'sown' or 'transplanted'");
    const nullDate = await p70Agent.post(url()).send({ cambiumSeedId: seed, cell: { x: 2, y: 0 }, plantingDate: null });
    expect(nullDate.status).toBe(400);
    expect(nullDate.body.error).toBe('plantingDate is required');
  });

  it('PATCH plantingDate null → 400; bad date or startMethod → 400', async () => {
    const seed = await timedSeed();
    const placed = await p70Agent.post(url()).send({ cambiumSeedId: seed, cell: { x: 3, y: 0 } });
    const nullDate = await p70Agent.patch(`/api/plantings/${placed.body.id}`).send({ plantingDate: null });
    expect(nullDate.status).toBe(400);
    expect(nullDate.body.error).toBe('plantingDate is required');
    const badDate = await p70Agent.patch(`/api/plantings/${placed.body.id}`).send({ plantingDate: '5/1/2026' });
    expect(badDate.status).toBe(400);
    expect(badDate.body.error).toBe('plantingDate must be a date string (YYYY-MM-DD)');
    const badMethod = await p70Agent.patch(`/api/plantings/${placed.body.id}`).send({ startMethod: 'cloned' });
    expect(badMethod.status).toBe(400);
  });

  it('PATCH re-dates the planting and the response carries the new stage', async () => {
    const seed = await timedSeed(65);
    const placed = await p70Agent.post(url()).send({
      cambiumSeedId: seed, cell: { x: 0, y: 1 }, startMethod: 'transplanted',
    });
    expect(placed.body.growth.stage).toBe(2);
    const date = await daysAgo(100);
    const res = await p70Agent.patch(`/api/plantings/${placed.body.id}`).send({ plantingDate: date });
    expect(res.status).toBe(200);
    expect(res.body.plantingDate).toBe(date);
    expect(res.body.growth).toMatchObject({ stage: 5, stagePct: 100, harvestReady: true });
    // The sowing event follows the new date.
    expect((await sowingEvents(seed))[0].marked_done_at?.toISOString()).toBe(await noonPacific(date));
  });

  it('PATCH a growing planting: previous-year date → 200 and stored; two years before → 400 and unchanged', async () => {
    const seed = await timedSeed();
    const placed = await p70Agent.post(url()).send({ cambiumSeedId: seed, cell: { x: 3, y: 6 } });
    expect(placed.status).toBe(201);
    const season = placed.body.season as number;
    const ok = `${season - 1}-12-11`;
    const good = await p70Agent.patch(`/api/plantings/${placed.body.id}`).send({ plantingDate: ok });
    expect(good.status).toBe(200);
    expect(good.body.plantingDate).toBe(ok);
    const bad = await p70Agent.patch(`/api/plantings/${placed.body.id}`).send({ plantingDate: `${season - 2}-12-11` });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("plantingDate must fall in the planting's season or the year before it");
    const { rows } = await pool.query<{ d: string }>(
      'SELECT planting_date::text AS d FROM plantings WHERE id = $1', [placed.body.id],
    );
    expect(rows[0].d).toBe(ok);
  });

  it('PATCH startMethod re-derives the stage', async () => {
    const seed = await timedSeed(60);
    const placed = await p70Agent.post(url()).send({ cambiumSeedId: seed, cell: { x: 1, y: 1 } });
    expect(placed.body.growth.stage).toBe(1);
    const res = await p70Agent.patch(`/api/plantings/${placed.body.id}`).send({ startMethod: 'transplanted' });
    expect(res.status).toBe(200);
    expect(res.body.startMethod).toBe('transplanted');
    expect(res.body.growth.stage).toBe(2);
  });

  it('places a plant and returns its growth fields populated in the same response', async () => {
    const seed = await timedSeed(60);
    const res = await p70Agent.post(url()).send({
      cambiumSeedId: seed, cell: { x: 2, y: 1 }, plantingDate: await daysAgo(30),
    });
    expect(res.status).toBe(201);
    expect(res.body.growth.stagePct).toBe(50);
    expect(res.body.growth.stage).toBe(3);
    expect(res.body.growth.anchored).toBe(true);
    expect(res.body.growth.harvestReady).toBe(false);
    expect(res.body.growth.harvestWindowEnd).not.toBeNull();
  });

  it('POST marks the sowing event done at noon Pacific on the planting date', async () => {
    const seed = await timedSeed();
    const date = await daysAgo(3);
    const res = await p70Agent.post(url()).send({ cambiumSeedId: seed, cell: { x: 3, y: 1 }, plantingDate: date });
    expect(res.status).toBe(201);
    const events = await sowingEvents(seed);
    expect(events).toHaveLength(1);
    expect(events[0].planting_id).toBe(res.body.id);
    expect(events[0].marked_done_at?.toISOString()).toBe(await noonPacific(date));
  });

  it('DELETE of the last planting un-does the event and keeps the row', async () => {
    const seed = await timedSeed();
    const a = await p70Agent.post(url()).send({ cambiumSeedId: seed, cell: { x: 0, y: 2 }, plantingDate: await daysAgo(10) });
    const laterDate = await daysAgo(4);
    const b = await p70Agent.post(url()).send({ cambiumSeedId: seed, cell: { x: 1, y: 2 }, plantingDate: laterDate });

    // With one planting left, the event follows its date.
    expect((await p70Agent.delete(`/api/plantings/${a.body.id}`)).status).toBe(204);
    let events = await sowingEvents(seed);
    expect(events).toHaveLength(1);
    expect(events[0].marked_done_at?.toISOString()).toBe(await noonPacific(laterDate));

    expect((await p70Agent.delete(`/api/plantings/${b.body.id}`)).status).toBe(204);
    events = await sowingEvents(seed);
    expect(events).toHaveLength(1);
    expect(events[0].marked_done_at).toBeNull();
  });

  it("a merge keeps the existing planting's date and start method", async () => {
    const seed = await timedSeed();
    const firstDate = await daysAgo(20);
    const first = await p70Agent.post(url()).send({
      cambiumSeedId: seed, cell: { x: 2, y: 2 }, plantingDate: firstDate, quantity: 2,
    });
    expect(first.status).toBe(201);
    const merged = await p70Agent.post(url()).send({
      cambiumSeedId: seed, cell: { x: 2, y: 2 }, plantingDate: await daysAgo(1),
      startMethod: 'transplanted', quantity: 3,
    });
    expect(merged.status).toBe(200);
    expect(merged.body.merged).toBe(true);
    expect(merged.body.id).toBe(first.body.id);
    expect(merged.body.quantity).toBe(5);
    expect(merged.body.plantingDate).toBe(firstDate);
    expect(merged.body.startMethod).toBe('sown');
    const events = await sowingEvents(seed);
    expect(events).toHaveLength(1);
    expect(events[0].marked_done_at?.toISOString()).toBe(await noonPacific(firstDate));
  });

  it('a planting with a NULL planting_date reads as its created_at Pacific date', async () => {
    const seed = await timedSeed();
    // Older code could still write NULL while the column is nullable.
    const { rows } = await pool.query<{ id: string; created: string }>(
      `INSERT INTO plantings (bed_id, garden_id, season, cambium_seed_id, cell_x, cell_y, planting_date, created_at)
       VALUES ($1, $2, $3, $4, 3, 3, NULL, '2026-03-02T05:00:00Z')
       RETURNING id::text, (created_at AT TIME ZONE 'America/Los_Angeles')::date::text AS created`,
      [bedId, p70GardenId, CURRENT_YEAR, seed],
    );
    // 05:00 UTC on March 2 is still March 1 in Pacific time.
    expect(rows[0].created).toBe('2026-03-01');
    for (const path of [`/api/gardens/${p70GardenId}/plantings`, url()]) {
      const res = await p70Agent.get(path);
      expect(res.status).toBe(200);
      const found = res.body.data.find((p: { id: string }) => p.id === rows[0].id);
      expect(found.plantingDate).toBe('2026-03-01');
    }
    const patched = await p70Agent.patch(`/api/plantings/${rows[0].id}`).send({ quantity: 2 });
    expect(patched.status).toBe(200);
    expect(patched.body.plantingDate).toBe('2026-03-01');
  });

  it('a failed sowing-event sync rolls the placement back → 500', async () => {
    const seed = await timedSeed();
    // Make the sync's insert fail for this seed only.
    await pool.query(`
      CREATE OR REPLACE FUNCTION p70_fail_sync() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'sync failed'; END $$`);
    await pool.query(`
      CREATE TRIGGER p70_fail_sync BEFORE INSERT ON sowing_events
      FOR EACH ROW WHEN (NEW.cambium_seed_id = ${seed}) EXECUTE FUNCTION p70_fail_sync()`);
    try {
      const res = await p70Agent.post(url()).send({ cambiumSeedId: seed, cell: { x: 3, y: 2 } });
      expect(res.status).toBe(500);
      const { rows } = await pool.query(
        'SELECT 1 FROM plantings WHERE garden_id = $1 AND cambium_seed_id = $2',
        [p70GardenId, seed],
      );
      expect(rows).toHaveLength(0);
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS p70_fail_sync ON sowing_events');
      await pool.query('DROP FUNCTION IF EXISTS p70_fail_sync()');
    }
  });
});

// ── Phase 76: planned plantings and mark-started ─────────────────────────────

describe('Phase 76: planned plantings', () => {
  // Its own account, so these writes don't run into another suite's write limit.
  let p76Agent: ReturnType<typeof request.agent>;
  let p76GardenId: string;
  let currentBedId: string;
  let nextBedId: string;
  let farBedId: string;
  let seedCounter = 0;
  const NEXT_YEAR = CURRENT_YEAR + 1;
  const bedUrl = (bed: string) => `/api/gardens/${p76GardenId}/beds/${bed}/plantings`;
  const startUrl = () => `/api/gardens/${p76GardenId}/plantings/start`;

  async function timedSeed(maturityDays = 60): Promise<number> {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO cambium.seeds (common_name, moderation_status, source, maturity_days_min, maturity_days_max)
       VALUES ($1, 'active', 'editorial', $2, $2) RETURNING id`,
      [`P76 Plant ${++seedCounter}`, maturityDays],
    );
    return rows[0].id;
  }

  async function gridBed(season: number): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO beds (garden_id, season, type, label, grid_x, grid_y, grid_cols, grid_rows)
       VALUES ($1, $2, 'grid', 'P76 Bed', 0, 0, 8, 8) RETURNING id::text`,
      [p76GardenId, season],
    );
    return rows[0].id;
  }

  async function storedRow(id: string) {
    const { rows } = await pool.query<{ state: string; planting_date: string | null; start_method: string }>(
      'SELECT state, planting_date::text, start_method FROM plantings WHERE id = $1',
      [id],
    );
    return rows[0];
  }

  beforeAll(async () => {
    await createUser('planting-p76@example.com');
    p76Agent = await loginAgent('planting-p76@example.com');
    const garden = await p76Agent.post('/api/gardens').send({
      name: 'P76 Garden', style: 'grid', zone: '7b', growingMethod: 'in_ground',
    });
    p76GardenId = garden.body.id;
    currentBedId = await gridBed(CURRENT_YEAR);
    nextBedId = await gridBed(NEXT_YEAR);
    farBedId = await gridBed(CURRENT_YEAR + 2);
  });

  it('a growing POST returns state growing', async () => {
    const seed = await timedSeed();
    const res = await p76Agent.post(bedUrl(currentBedId)).send({ cambiumSeedId: seed, cell: { x: 7, y: 7 } });
    expect(res.status).toBe(201);
    expect(res.body.state).toBe('growing');
    expect(res.body.plantingDate).toBe(todayPacific());
  });

  it('POST planned stores a null date and returns a null stage', async () => {
    const seed = await timedSeed();
    const res = await p76Agent.post(bedUrl(currentBedId)).send({
      cambiumSeedId: seed, cell: { x: 0, y: 0 }, state: 'planned', startMethod: 'transplanted',
    });
    expect(res.status).toBe(201);
    expect(res.body.state).toBe('planned');
    expect(res.body.plantingDate).toBeNull();
    expect(res.body.startMethod).toBe('transplanted');
    expect(res.body.growth.stage).toBeNull();
    expect(res.body.growth.harvestReady).toBe(false);
    expect(await storedRow(res.body.id)).toEqual({
      state: 'planned', planting_date: null, start_method: 'transplanted',
    });
    // GET reads the same.
    const list = await p76Agent.get(`/api/gardens/${p76GardenId}/plantings`);
    const found = list.body.data.find((p: { id: string }) => p.id === res.body.id);
    expect(found.state).toBe('planned');
    expect(found.plantingDate).toBeNull();
  });

  it('POST into next season forces planned even if growing is sent', async () => {
    const seed = await timedSeed();
    const res = await p76Agent.post(bedUrl(nextBedId)).send({
      cambiumSeedId: seed, cell: { x: 0, y: 0 }, state: 'growing',
    });
    expect(res.status).toBe(201);
    expect(res.body.season).toBe(NEXT_YEAR);
    expect(res.body.state).toBe('planned');
    expect(res.body.plantingDate).toBeNull();
    expect((await storedRow(res.body.id)).state).toBe('planned');
  });

  it("POST into next season with today's plantingDate stores NULL and returns state planned", async () => {
    const seed = await timedSeed();
    const res = await p76Agent.post(bedUrl(nextBedId)).send({
      cambiumSeedId: seed, cell: { x: 1, y: 0 }, plantingDate: todayPacific(),
    });
    expect(res.status).toBe(201);
    expect(res.body.state).toBe('planned');
    expect(res.body.plantingDate).toBeNull();
    expect((await storedRow(res.body.id)).planting_date).toBeNull();
    // A malformed date on a planned planting is ignored too.
    const malformed = await p76Agent.post(bedUrl(currentBedId)).send({
      cambiumSeedId: seed, cell: { x: 1, y: 0 }, state: 'planned', plantingDate: 'soon',
    });
    expect(malformed.status).toBe(201);
    expect(malformed.body.plantingDate).toBeNull();
  });

  it('POST growing with a plantingDate two years before the bed season → 400, no row', async () => {
    const seed = await timedSeed();
    const res = await p76Agent.post(bedUrl(currentBedId)).send({
      cambiumSeedId: seed, cell: { x: 6, y: 6 }, plantingDate: `${CURRENT_YEAR - 2}-12-11`,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("plantingDate must fall in the planting's season or the year before it");
    const { rows } = await pool.query(
      'SELECT id FROM plantings WHERE bed_id = $1 AND cell_x = 6 AND cell_y = 6',
      [currentBedId],
    );
    expect(rows).toHaveLength(0);
  });

  it('POST with an unknown state → 400, even into next season', async () => {
    const seed = await timedSeed();
    for (const bed of [currentBedId, nextBedId]) {
      const res = await p76Agent.post(bedUrl(bed)).send({ cambiumSeedId: seed, cell: { x: 2, y: 0 }, state: 'dormant' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("state must be 'planned' or 'growing'");
    }
  });

  it('POST into season current+2 → 400', async () => {
    const seed = await timedSeed();
    const res = await p76Agent.post(bedUrl(farBedId)).send({ cambiumSeedId: seed, cell: { x: 0, y: 0 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('That season is too far ahead to plan');
  });

  it('grid drop of a planned plant onto a growing same plant → 409', async () => {
    const seed = await timedSeed();
    const growing = await p76Agent.post(bedUrl(currentBedId)).send({ cambiumSeedId: seed, cell: { x: 3, y: 0 } });
    expect(growing.status).toBe(201);
    const res = await p76Agent.post(bedUrl(currentBedId)).send({
      cambiumSeedId: seed, cell: { x: 3, y: 0 }, state: 'planned',
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CELL_OCCUPIED');
    expect(res.body.occupant.id).toBe(growing.body.id);
    // Two planned plantings of the same plant still merge.
    const a = await p76Agent.post(bedUrl(nextBedId)).send({ cambiumSeedId: seed, cell: { x: 3, y: 0 }, quantity: 2 });
    const b = await p76Agent.post(bedUrl(nextBedId)).send({ cambiumSeedId: seed, cell: { x: 3, y: 0 }, quantity: 3 });
    expect(b.status).toBe(200);
    expect(b.body.merged).toBe(true);
    expect(b.body.id).toBe(a.body.id);
    expect(b.body.quantity).toBe(5);
  });

  it('PATCH plantingDate on a planned planting → 400; startMethod may change', async () => {
    const seed = await timedSeed();
    const placed = await p76Agent.post(bedUrl(nextBedId)).send({ cambiumSeedId: seed, cell: { x: 4, y: 0 } });
    const dated = await p76Agent.patch(`/api/plantings/${placed.body.id}`).send({ plantingDate: `${NEXT_YEAR}-04-01` });
    expect(dated.status).toBe(400);
    expect(dated.body.error).toBe('Use mark-started to give a planned plant a date');
    const method = await p76Agent.patch(`/api/plantings/${placed.body.id}`).send({ startMethod: 'transplanted' });
    expect(method.status).toBe(200);
    expect(method.body.state).toBe('planned');
    expect(method.body.startMethod).toBe('transplanted');
    expect(method.body.plantingDate).toBeNull();
    expect(method.body.growth.stage).toBeNull();
  });

  it('/start marks two planned plantings growing, dates them, and the Guide event becomes done', async () => {
    const seedA = await timedSeed();
    const seedB = await timedSeed();
    const a = await p76Agent.post(bedUrl(currentBedId)).send({ cambiumSeedId: seedA, cell: { x: 0, y: 1 }, state: 'planned' });
    const b = await p76Agent.post(bedUrl(currentBedId)).send({
      cambiumSeedId: seedB, cell: { x: 1, y: 1 }, state: 'planned', startMethod: 'transplanted',
    });
    // Planned plantings don't sow: no done event yet.
    const { rows: before } = await pool.query(
      'SELECT 1 FROM sowing_events WHERE garden_id = $1 AND cambium_seed_id = $2 AND marked_done_at IS NOT NULL',
      [p76GardenId, seedA],
    );
    expect(before).toHaveLength(0);

    const today = todayPacific();
    const sown = await p76Agent.post(startUrl()).send({
      plantingIds: [a.body.id], startMethod: 'sown', plantingDate: today,
    });
    expect(sown.status).toBe(200);
    expect(sown.body.data).toHaveLength(1);
    expect(sown.body.data[0]).toMatchObject({ id: a.body.id, state: 'growing', plantingDate: today, startMethod: 'sown' });
    expect(sown.body.data[0].growth.stage).toBe(1);

    const transplanted = await p76Agent.post(startUrl()).send({
      plantingIds: [Number(b.body.id)], startMethod: 'transplanted', plantingDate: today,
    });
    expect(transplanted.status).toBe(200);
    expect(transplanted.body.data[0]).toMatchObject({ id: b.body.id, state: 'growing', plantingDate: today });
    expect(transplanted.body.data[0].growth.stage).toBe(2);

    expect(await storedRow(a.body.id)).toEqual({ state: 'growing', planting_date: today, start_method: 'sown' });
    for (const seed of [seedA, seedB]) {
      const { rows } = await pool.query<{ marked_done_at: Date | null }>(
        'SELECT marked_done_at FROM sowing_events WHERE garden_id = $1 AND cambium_seed_id = $2 ORDER BY id',
        [p76GardenId, seed],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].marked_done_at?.toISOString()).toBe(await noonPacific(today));
    }
  });

  it('/start takes several plantings at once', async () => {
    const seed = await timedSeed();
    const a = await p76Agent.post(bedUrl(currentBedId)).send({ cambiumSeedId: seed, cell: { x: 2, y: 1 }, state: 'planned' });
    const b = await p76Agent.post(bedUrl(currentBedId)).send({ cambiumSeedId: seed, cell: { x: 3, y: 1 }, state: 'planned' });
    const res = await p76Agent.post(startUrl()).send({
      plantingIds: [b.body.id, a.body.id, a.body.id], startMethod: 'sown', plantingDate: todayPacific(),
    });
    expect(res.status).toBe(200);
    expect(res.body.data.map((p: { id: string }) => p.id).sort()).toEqual([a.body.id, b.body.id].sort());
    expect(res.body.data.every((p: { state: string }) => p.state === 'growing')).toBe(true);
  });

  it('/start on a growing planting → 409 and changes nothing', async () => {
    const seed = await timedSeed();
    const planned = await p76Agent.post(bedUrl(currentBedId)).send({ cambiumSeedId: seed, cell: { x: 4, y: 1 }, state: 'planned' });
    const growing = await p76Agent.post(bedUrl(currentBedId)).send({ cambiumSeedId: seed, cell: { x: 5, y: 1 } });
    const res = await p76Agent.post(startUrl()).send({
      plantingIds: [planned.body.id, growing.body.id], startMethod: 'sown', plantingDate: todayPacific(),
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Already in the ground');
    expect((await storedRow(planned.body.id)).state).toBe('planned');
  });

  it("/start with a date outside the season's year → 400", async () => {
    const seed = await timedSeed();
    const planned = await p76Agent.post(bedUrl(currentBedId)).send({ cambiumSeedId: seed, cell: { x: 6, y: 1 }, state: 'planned' });
    const res = await p76Agent.post(startUrl()).send({
      plantingIds: [planned.body.id], startMethod: 'sown', plantingDate: `${NEXT_YEAR}-03-01`,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("plantingDate must fall in the planting's season or the year before it");
    expect((await storedRow(planned.body.id)).state).toBe('planned');
  });

  // NEXT_YEAR is nextSeason(), so these stay writable whenever they run.
  it('/start a next-season planting with a date in the year before → 200', async () => {
    const seed = await timedSeed();
    const planned = await p76Agent.post(bedUrl(nextBedId)).send({ cambiumSeedId: seed, cell: { x: 0, y: 5 }, state: 'planned' });
    expect(planned.status).toBe(201);
    const res = await p76Agent.post(startUrl()).send({
      plantingIds: [planned.body.id], startMethod: 'sown', plantingDate: `${NEXT_YEAR - 1}-12-11`,
    });
    expect(res.status).toBe(200);
    expect(await storedRow(planned.body.id)).toMatchObject({ state: 'growing', planting_date: `${NEXT_YEAR - 1}-12-11` });
  });

  it('/start a next-season planting with a date two years before → 400', async () => {
    const seed = await timedSeed();
    const planned = await p76Agent.post(bedUrl(nextBedId)).send({ cambiumSeedId: seed, cell: { x: 1, y: 5 }, state: 'planned' });
    expect(planned.status).toBe(201);
    const res = await p76Agent.post(startUrl()).send({
      plantingIds: [planned.body.id], startMethod: 'sown', plantingDate: `${NEXT_YEAR - 2}-12-11`,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("plantingDate must fall in the planting's season or the year before it");
    expect((await storedRow(planned.body.id)).state).toBe('planned');
  });

  it("/start with another garden's planting → 404", async () => {
    const res = await p76Agent.post(startUrl()).send({
      plantingIds: [gridPlantingId], startMethod: 'sown', plantingDate: todayPacific(),
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Planting not found');
    // Another session can't start plantings in this garden.
    const other = await otherAgent.post(startUrl()).send({
      plantingIds: [gridPlantingId], startMethod: 'sown', plantingDate: todayPacific(),
    });
    expect(other.status).toBe(404);
  });

  it('/start validates its body', async () => {
    const today = todayPacific();
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ plantingIds: [], startMethod: 'sown', plantingDate: today }, 'plantingIds must be an array of 1 to 200 ids'],
      [{ plantingIds: Array.from({ length: 201 }, (_, i) => i + 1), startMethod: 'sown', plantingDate: today },
        'plantingIds must be an array of 1 to 200 ids'],
      [{ plantingIds: [0], startMethod: 'sown', plantingDate: today }, 'plantingIds must contain positive integer ids'],
      [{ plantingIds: [1], startMethod: 'cloned', plantingDate: today }, "startMethod must be 'sown' or 'transplanted'"],
      [{ plantingIds: [1], startMethod: 'sown' }, 'plantingDate is required'],
      [{ plantingIds: [1], startMethod: 'sown', plantingDate: '3/1' }, 'plantingDate must be a date string (YYYY-MM-DD)'],
      [{ plantingIds: [1], startMethod: 'sown', plantingDate: `${CURRENT_YEAR}-02-30` }, 'plantingDate must be a real date'],
    ];
    for (const [body, error] of cases) {
      const res = await p76Agent.post(startUrl()).send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe(error);
    }
  });
});

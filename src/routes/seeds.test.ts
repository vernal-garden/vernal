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
    'TRUNCATE accounts, guest_sessions, seeds, moderation_items RESTART IDENTITY CASCADE',
  );
  await pool.query('TRUNCATE cambium.seeds RESTART IDENTITY CASCADE');
}

async function createUser(email: string, password = 'Password123!'): Promise<number> {
  const hash = await bcrypt.hash(password, 4);
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO accounts (email, password_hash, zone, zone_location_label, email_verified)
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

let agent1: ReturnType<typeof request.agent>;
let agent2: ReturnType<typeof request.agent>;
let cambiumSeedId: number;
let flaggedCambiumSeedId: number;

beforeAll(async () => {
  await resetDb();

  // Insert active cambium seed with 009 fields populated
  const { rows: csRows } = await pool.query<{ id: number }>(
    `INSERT INTO cambium.seeds (
       common_name, plant_family, spacing_inches, moderation_status, source,
       planting_depth_inches, row_spacing_inches,
       germination_days_min, germination_days_max,
       germination_temp_min_f, germination_temp_max_f
     ) VALUES ('Cambium Tomato', 'Solanaceae', 18, 'active', 'editorial', 0.25, 24, 7, 14, 60, 75)
     RETURNING id`,
  );
  cambiumSeedId = csRows[0].id;

  // Insert flagged cambium seed
  const { rows: fsRows } = await pool.query<{ id: number }>(
    `INSERT INTO cambium.seeds (common_name, moderation_status, source)
     VALUES ('Flagged Plant', 'flagged', 'editorial')
     RETURNING id`,
  );
  flaggedCambiumSeedId = fsRows[0].id;

  await createUser('seeds-user1@example.com');
  await createUser('seeds-user2@example.com');
  agent1 = await loginAgent('seeds-user1@example.com');
  agent2 = await loginAgent('seeds-user2@example.com');
});

afterAll(() => pool.end());

// ── 1. POST minimal ───────────────────────────────────────────────────────────

describe('POST /api/seeds — minimal', () => {
  it('creates with correct defaults', async () => {
    const res = await agent1.post('/api/seeds').send({ commonName: 'Tomato', plantFamily: 'Solanaceae' });
    expect(res.status).toBe(201);
    expect(res.body.origin).toBe('user_created');
    expect(res.body.contributionStatus).toBe('private');
    expect(res.body.tags).toEqual([]);
    expect(res.body.id).toBeDefined();
    expect(res.body.cambiumSourceId).toBeNull();
  });
});

// ── 2. POST full 009 fields ───────────────────────────────────────────────────

describe('POST /api/seeds — full growing fields', () => {
  it('creates with all 009 columns and tags echoed back', async () => {
    const res = await agent1.post('/api/seeds').send({
      commonName: 'Cherry Tomato',
      plantFamily: 'Solanaceae',
      spacingInches: 18,
      plantingDepthInches: 0.25,
      rowSpacingInches: 24,
      maturityDaysMin: 65,
      maturityDaysMax: 75,
      germinationDaysMin: 7,
      germinationDaysMax: 14,
      germinationTempMinF: 60,
      germinationTempMaxF: 85,
      sunlight: 'full_sun',
      wateringNeeds: 'moderate',
      frostTolerance: 'none',
      weeksToTransplant: 6,
      successionIntervalWeeks: 3,
      userNotes: 'Great for containers',
      userRating: 4,
      isFavourite: true,
      tags: ['easy', 'productive'],
    });
    expect(res.status).toBe(201);
    expect(res.body.plantingDepthInches).toBe(0.25);
    expect(res.body.rowSpacingInches).toBe(24);
    expect(res.body.germinationDaysMin).toBe(7);
    expect(res.body.germinationDaysMax).toBe(14);
    expect(res.body.germinationTempMinF).toBe(60);
    expect(res.body.germinationTempMaxF).toBe(85);
    expect(res.body.tags).toEqual(['easy', 'productive']);
    expect(res.body.isFavourite).toBe(true);
    expect(res.body.userRating).toBe(4);
  });
});

// ── 3. POST validation errors ─────────────────────────────────────────────────

describe('POST /api/seeds — validation', () => {
  it('rejects missing plantFamily', async () => {
    const res = await agent1.post('/api/seeds').send({ commonName: 'Tomato' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/plantFamily/);
  });

  it('rejects bad sunlight enum', async () => {
    const res = await agent1.post('/api/seeds').send({
      commonName: 'X',
      plantFamily: 'Y',
      sunlight: 'blinding',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sunlight/);
  });

  it('rejects germination days min > max', async () => {
    const res = await agent1.post('/api/seeds').send({
      commonName: 'X',
      plantFamily: 'Y',
      germinationDaysMin: 14,
      germinationDaysMax: 7,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/germinationDaysMin/);
  });

  it('rejects 21 tags', async () => {
    const tags = Array.from({ length: 21 }, (_, i) => `tag${i}`);
    const res = await agent1.post('/api/seeds').send({ commonName: 'X', plantFamily: 'Y', tags });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/20/);
  });
});

// ── 4. Duplicate common names allowed ─────────────────────────────────────────

describe('POST /api/seeds — duplicates', () => {
  it('allows duplicate common names for the same owner', async () => {
    const [r1, r2] = await Promise.all([
      agent1.post('/api/seeds').send({ commonName: 'Duplicate Name', plantFamily: 'Fam' }),
      agent1.post('/api/seeds').send({ commonName: 'Duplicate Name', plantFamily: 'Fam' }),
    ]);
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r1.body.id).not.toBe(r2.body.id);
  });
});

// ── 5. GET list filters & isolation ──────────────────────────────────────────

describe('GET /api/seeds — list', () => {
  let agent1ListSeedId: string;

  beforeAll(async () => {
    const r = await agent1.post('/api/seeds').send({
      commonName: 'Basil',
      plantFamily: 'Lamiaceae',
      scientificName: 'Ocimum basilicum',
      isFavourite: true,
    });
    agent1ListSeedId = r.body.id;
    await agent1.post('/api/seeds').send({ commonName: 'Mint', plantFamily: 'Lamiaceae' });
    await agent2.post('/api/seeds').send({ commonName: 'Oregano', plantFamily: 'Lamiaceae' });
  });

  it('q matches scientific name', async () => {
    const res = await agent1.get('/api/seeds?q=basilicum');
    expect(res.status).toBe(200);
    const names = res.body.data.map((s: { scientificName: string }) => s.scientificName);
    expect(names).toContain('Ocimum basilicum');
  });

  it('family filter returns only matching family', async () => {
    const res = await agent1.get('/api/seeds?family=Lamiaceae');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(
      res.body.data.every((s: { plantFamily: string }) => s.plantFamily === 'Lamiaceae'),
    ).toBe(true);
  });

  it('favourite filter returns only favourites', async () => {
    const res = await agent1.get('/api/seeds?favourite=true');
    expect(res.status).toBe(200);
    const ids = res.body.data.map((s: { id: string }) => s.id);
    expect(ids).toContain(agent1ListSeedId);
    expect(res.body.data.every((s: { isFavourite: boolean }) => s.isFavourite)).toBe(true);
  });

  it('pagination total reflects all matching seeds', async () => {
    const res = await agent1.get('/api/seeds?limit=1&offset=0');
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThan(1);
    expect(res.body.data.length).toBe(1);
    expect(res.body.limit).toBe(1);
    expect(res.body.offset).toBe(0);
  });

  it("other user's seeds never appear", async () => {
    const res = await agent1.get('/api/seeds');
    expect(res.status).toBe(200);
    const commonNames = res.body.data.map((s: { commonName: string }) => s.commonName);
    expect(commonNames).not.toContain('Oregano');
  });
});

// ── 6. GET /:id ownership ─────────────────────────────────────────────────────

describe('GET /api/seeds/:id', () => {
  it("returns 404 for another user's seed", async () => {
    const create = await agent1.post('/api/seeds').send({ commonName: 'Private', plantFamily: 'Fam' });
    const res = await agent2.get(`/api/seeds/${create.body.id}`);
    expect(res.status).toBe(404);
  });
});

// ── 7. PATCH ─────────────────────────────────────────────────────────────────

describe('PATCH /api/seeds/:id', () => {
  let patchSeedId: string;

  beforeAll(async () => {
    const r = await agent1.post('/api/seeds').send({ commonName: 'Patch Target', plantFamily: 'Fam' });
    patchSeedId = r.body.id;
  });

  it('patches userRating, isFavourite, and tags', async () => {
    const res = await agent1
      .patch(`/api/seeds/${patchSeedId}`)
      .send({ userRating: 5, isFavourite: true, tags: ['tomato', 'easy'] });
    expect(res.status).toBe(200);
    expect(res.body.userRating).toBe(5);
    expect(res.body.isFavourite).toBe(true);
    expect(res.body.tags).toEqual(['tomato', 'easy']);
  });

  it('rejects patching origin', async () => {
    const res = await agent1.patch(`/api/seeds/${patchSeedId}`).send({ origin: 'user_created' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/origin/);
  });

  it('rejects patching contributionStatus', async () => {
    const res = await agent1
      .patch(`/api/seeds/${patchSeedId}`)
      .send({ contributionStatus: 'approved' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/contributionStatus/);
  });

  it('rejects empty patch body', async () => {
    const res = await agent1.patch(`/api/seeds/${patchSeedId}`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/No fields/);
  });
});

// ── 8. GET /:id planting history ──────────────────────────────────────────────

describe('GET /api/seeds/:id — plantingHistory', () => {
  it('returns one history entry with correct garden/bed names', async () => {
    const seedRes = await agent1.post('/api/seeds').send({ commonName: 'History Seed', plantFamily: 'Fam' });
    const seedId = seedRes.body.id;

    const { rows: accRows } = await pool.query<{ id: number }>(
      `SELECT id FROM accounts WHERE email = 'seeds-user1@example.com'`,
    );
    const accountId = accRows[0].id;

    const { rows: gardenRows } = await pool.query<{ id: number }>(
      `INSERT INTO gardens (owner_id, name, style, zone)
       VALUES ($1, 'History Garden', 'grid', '7b') RETURNING id`,
      [accountId],
    );
    const gardenId = gardenRows[0].id;

    const { rows: bedRows } = await pool.query<{ id: number }>(
      `INSERT INTO beds (garden_id, season, type, grid_x, grid_y, grid_cols, grid_rows)
       VALUES ($1, 2026, 'grid', 0, 0, 8, 8) RETURNING id`,
      [gardenId],
    );
    const bedId = bedRows[0].id;

    await pool.query(
      `INSERT INTO plantings (bed_id, garden_id, season, seed_id, cell_x, cell_y)
       VALUES ($1, $2, 2026, $3, 0, 0)`,
      [bedId, gardenId, seedId],
    );

    const res = await agent1.get(`/api/seeds/${seedId}`);
    expect(res.status).toBe(200);
    expect(res.body.plantingHistory).toHaveLength(1);
    expect(res.body.plantingHistory[0].gardenName).toBe('History Garden');
    expect(res.body.plantingHistory[0].bedLabel).toBe('');
    expect(res.body.plantingHistory[0].harvestLogged).toBe(false);
    expect(res.body.plantingHistory[0].season).toBe(2026);

    // cleanup
    await pool.query('DELETE FROM gardens WHERE id = $1', [gardenId]);
  });
});

// ── 9. DELETE guard ───────────────────────────────────────────────────────────

describe('DELETE /api/seeds/:id', () => {
  let plantedSeedId: string;
  let plantingDbId: number;
  let gardenDbId: number;

  beforeAll(async () => {
    const r = await agent1.post('/api/seeds').send({ commonName: 'Delete Guard Seed', plantFamily: 'Fam' });
    plantedSeedId = r.body.id;

    const { rows: accRows } = await pool.query<{ id: number }>(
      `SELECT id FROM accounts WHERE email = 'seeds-user1@example.com'`,
    );
    const accountId = accRows[0].id;

    const { rows: gardenRows } = await pool.query<{ id: number }>(
      `INSERT INTO gardens (owner_id, name, style, zone)
       VALUES ($1, 'Guard Garden', 'grid', '7b') RETURNING id`,
      [accountId],
    );
    gardenDbId = gardenRows[0].id;

    const { rows: bedRows } = await pool.query<{ id: number }>(
      `INSERT INTO beds (garden_id, season, type, grid_x, grid_y, grid_cols, grid_rows)
       VALUES ($1, 2026, 'grid', 0, 0, 4, 4) RETURNING id`,
      [gardenDbId],
    );
    const bedId = bedRows[0].id;

    const { rows: plantingRows } = await pool.query<{ id: number }>(
      `INSERT INTO plantings (bed_id, garden_id, season, seed_id, cell_x, cell_y)
       VALUES ($1, $2, 2026, $3, 0, 0) RETURNING id`,
      [bedId, gardenDbId, plantedSeedId],
    );
    plantingDbId = plantingRows[0].id;
  });

  afterAll(() => pool.query('DELETE FROM gardens WHERE id = $1', [gardenDbId]));

  it('DELETE planted seed → 409 with plantingCount 1', async () => {
    const res = await agent1.delete(`/api/seeds/${plantedSeedId}`);
    expect(res.status).toBe(409);
    expect(res.body.plantingCount).toBe(1);
    expect(res.body.error).toMatch(/planted/);
  });

  it('DELETE after removing planting → 204', async () => {
    await pool.query('DELETE FROM plantings WHERE id = $1', [plantingDbId]);
    const res = await agent1.delete(`/api/seeds/${plantedSeedId}`);
    expect(res.status).toBe(204);
  });
});

// ── 10. add-from-cambium ──────────────────────────────────────────────────────

describe('POST /api/seeds/add-from-cambium', () => {
  it('imports with origin cambium_imported, cambiumSourceId set, 009 fields copied', async () => {
    const res = await agent1.post('/api/seeds/add-from-cambium').send({ cambiumSeedId });
    expect(res.status).toBe(201);
    expect(res.body.origin).toBe('cambium_imported');
    expect(res.body.cambiumSourceId).toBe(String(cambiumSeedId));
    expect(res.body.plantingDepthInches).toBe(0.25);
    expect(res.body.rowSpacingInches).toBe(24);
    expect(res.body.germinationDaysMin).toBe(7);
    expect(res.body.germinationTempMinF).toBe(60);
    expect(res.body.tags).toEqual([]);
  });

  it('repeat import → 409 alreadyInCatalogue with seedId', async () => {
    const res = await agent1.post('/api/seeds/add-from-cambium').send({ cambiumSeedId });
    expect(res.status).toBe(409);
    expect(res.body.alreadyInCatalogue).toBe(true);
    expect(res.body.seedId).toBeDefined();
  });

  it('flagged cambium id → 400', async () => {
    const res = await agent1
      .post('/api/seeds/add-from-cambium')
      .send({ cambiumSeedId: flaggedCambiumSeedId });
    expect(res.status).toBe(400);
  });
});

// ── 11 & 12. contribute ───────────────────────────────────────────────────────

describe('POST /api/seeds/:id/contribute', () => {
  let userSeedId: string;
  let importedSeedId: string;

  beforeAll(async () => {
    const r1 = await agent1.post('/api/seeds').send({ commonName: 'Contribute Me', plantFamily: 'Fam' });
    userSeedId = r1.body.id;

    // agent2 imports the cambium seed (different owner, so no dup conflict)
    const r2 = await agent2.post('/api/seeds/add-from-cambium').send({ cambiumSeedId });
    importedSeedId = r2.body.id;
  });

  it('user_created private seed → 200 pending', async () => {
    const res = await agent1.post(`/api/seeds/${userSeedId}/contribute`).send({});
    expect(res.status).toBe(200);
    expect(res.body.contributionStatus).toBe('pending');
  });

  it('moderation_items row exists with type new_seed and snapshot content', async () => {
    const { rows } = await pool.query<{ type: string; content: Record<string, unknown> }>(
      `SELECT type, content FROM moderation_items WHERE seed_id = $1`,
      [userSeedId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('new_seed');
    expect(rows[0].content.commonName).toBe('Contribute Me');
  });

  it('contribute again → 400 (already pending)', async () => {
    const res = await agent1.post(`/api/seeds/${userSeedId}/contribute`).send({});
    expect(res.status).toBe(400);
  });

  it('contribute an imported seed → 400', async () => {
    const res = await agent2.post(`/api/seeds/${importedSeedId}/contribute`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/[Ii]mported/);
  });

  it('12. rejected seed can be resubmitted', async () => {
    const r = await agent1
      .post('/api/seeds')
      .send({ commonName: 'Resubmit Seed', plantFamily: 'Fam' });
    const sid = r.body.id;
    await pool.query(`UPDATE seeds SET contribution_status = 'rejected' WHERE id = $1`, [sid]);
    const res = await agent1.post(`/api/seeds/${sid}/contribute`).send({});
    expect(res.status).toBe(200);
    expect(res.body.contributionStatus).toBe('pending');
  });
});

// ── 13. corrections ───────────────────────────────────────────────────────────

describe('POST /api/corrections', () => {
  it('valid cambium id → 201 received', async () => {
    const res = await agent1.post('/api/corrections').send({
      cambiumSeedId,
      correctionText: 'Spacing should be 24 inches not 18',
    });
    expect(res.status).toBe(201);
    expect(res.body.received).toBe(true);
  });

  it('moderation_items row has type correction and correctionText', async () => {
    const { rows } = await pool.query<{ type: string; content: Record<string, unknown> }>(
      `SELECT type, content FROM moderation_items
       WHERE cambium_seed_id = $1 AND type = 'correction'
       ORDER BY created_at DESC LIMIT 1`,
      [cambiumSeedId],
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].type).toBe('correction');
    expect(rows[0].content.correctionText).toBe('Spacing should be 24 inches not 18');
    expect(rows[0].content.seedName).toBe('Cambium Tomato');
  });

  it('seedId in body → 400 directing to PATCH', async () => {
    const r = await agent1.post('/api/seeds').send({ commonName: 'My Own', plantFamily: 'Fam' });
    const res = await agent1.post('/api/corrections').send({
      seedId: r.body.id,
      correctionText: 'Fix this',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/PATCH/);
  });

  it('empty correctionText → 400', async () => {
    const res = await agent1
      .post('/api/corrections')
      .send({ cambiumSeedId, correctionText: '   ' });
    expect(res.status).toBe(400);
  });
});

// ── 14. Auth guards ───────────────────────────────────────────────────────────

describe('Auth guards', () => {
  it('401 with no session on all seeds/corrections routes', async () => {
    const results = await Promise.all([
      request(app).get('/api/seeds'),
      request(app).post('/api/seeds').send({ commonName: 'X', plantFamily: 'Y' }),
      request(app).get('/api/seeds/1'),
      request(app).patch('/api/seeds/1').send({ commonName: 'X' }),
      request(app).delete('/api/seeds/1'),
      request(app).post('/api/seeds/add-from-cambium').send({ cambiumSeedId: 1 }),
      request(app).post('/api/seeds/1/contribute').send({}),
      request(app).post('/api/corrections').send({ cambiumSeedId: 1, correctionText: 'X' }),
    ]);
    for (const r of results) {
      expect(r.status).toBe(401);
    }
  });

  it('401 with a guest session', async () => {
    const guestAgent = request.agent(app);
    await guestAgent.post('/api/auth/guest');
    const results = await Promise.all([
      guestAgent.get('/api/seeds'),
      guestAgent.post('/api/seeds').send({ commonName: 'X', plantFamily: 'Y' }),
      guestAgent.post('/api/corrections').send({ cambiumSeedId: 1, correctionText: 'X' }),
    ]);
    for (const r of results) {
      expect(r.status).toBe(401);
    }
  });
});

// ── 15. Catalogue detail includes 009 fields ──────────────────────────────────

describe('GET /api/catalogue/seeds/:id — 009 fields', () => {
  it('includes plantingDepthInches, rowSpacingInches, germinationDays*, germinationTemp*', async () => {
    const res = await request(app).get(`/api/catalogue/seeds/${cambiumSeedId}`);
    expect(res.status).toBe(200);
    expect(res.body.plantingDepthInches).toBe(0.25);
    expect(res.body.rowSpacingInches).toBe(24);
    expect(res.body.germinationDaysMin).toBe(7);
    expect(res.body.germinationDaysMax).toBe(14);
    expect(res.body.germinationTempMinF).toBe(60);
    expect(res.body.germinationTempMaxF).toBe(75);
  });
});

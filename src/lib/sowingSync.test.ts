import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import { currentSeason } from './season';
import { syncSowingEvent, type SeedKey } from './sowingSync';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL must be set to run tests');

const pool = new Pool({ connectionString: url });

const SEASON = currentSeason();

// "N days ago" is measured in Pacific time, matching the sync's notion of a date.
const PACIFIC_TODAY = `(NOW() AT TIME ZONE 'America/Los_Angeles')::date`;

async function resetDb() {
  await pool.query(
    `TRUNCATE accounts, guest_sessions, gardens, beds, plantings, seeds, sowing_events,
       harvest_entries RESTART IDENTITY CASCADE`,
  );
  await pool.query('TRUNCATE cambium.seeds RESTART IDENTITY CASCADE');
}

beforeEach(resetDb);
afterAll(() => pool.end());

// syncSowingEvent must run inside a transaction, as the plantings routes run it.
async function syncSowingEventNow(
  db: Pool,
  gardenId: number,
  key: SeedKey,
  season: number,
): Promise<void> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await syncSowingEvent(client, gardenId, key, season);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function setup() {
  const { rows: accounts } = await pool.query<{ id: number }>(
    `INSERT INTO accounts (email, zone, zone_location_label)
     VALUES ('sowing-sync@example.com', '7b', 'Test City') RETURNING id`,
  );
  const ownerId = accounts[0].id;
  const { rows: gardens } = await pool.query<{ id: number }>(
    `INSERT INTO gardens (owner_id, name, style, zone)
     VALUES ($1, 'Sowing Sync Garden', 'grid', '7b') RETURNING id`,
    [ownerId],
  );
  const gardenId = gardens[0].id;
  const { rows: beds } = await pool.query<{ id: number }>(
    `INSERT INTO beds (garden_id, season, type, grid_x, grid_y, grid_cols, grid_rows)
     VALUES ($1, $2, 'grid', 0, 0, 4, 4) RETURNING id`,
    [gardenId, SEASON],
  );
  return { ownerId, gardenId, bedId: beds[0].id };
}

async function createCambiumSeed(): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO cambium.seeds (common_name, source)
     VALUES ('Sowing Sync Plant', 'editorial') RETURNING id`,
  );
  return rows[0].id;
}

async function createPersonalSeed(ownerId: number, cambiumSourceId: number | null = null): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO seeds (owner_id, common_name, origin, contribution_status, cambium_source_id)
     VALUES ($1, 'Sowing Sync Plant', $2, 'private', $3) RETURNING id`,
    [ownerId, cambiumSourceId === null ? 'user_created' : 'cambium_imported', cambiumSourceId],
  );
  return rows[0].id;
}

async function createPlanting(
  bedId: number,
  gardenId: number,
  opts: { seedId?: number | null; cambiumSeedId?: number | null; daysAgo: number },
): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO plantings
       (bed_id, garden_id, season, seed_id, cambium_seed_id, planting_date, cell_x, cell_y)
     VALUES ($1, $2, $3, $4, $5, ${PACIFIC_TODAY} - $6::int,
             (SELECT COUNT(*)::int FROM plantings WHERE bed_id = $1), 0)
     RETURNING id`,
    [bedId, gardenId, SEASON, opts.seedId ?? null, opts.cambiumSeedId ?? null, opts.daysAgo],
  );
  return rows[0].id;
}

// Noon Pacific on the date `daysAgo` days back, as the sync stamps it.
async function noonPacific(daysAgo: number): Promise<string> {
  const { rows } = await pool.query<{ t: Date }>(
    `SELECT (${PACIFIC_TODAY} - $1::int + time '12:00') AT TIME ZONE 'America/Los_Angeles' AS t`,
    [daysAgo],
  );
  return rows[0].t.toISOString();
}

interface EventRow {
  id: number;
  planting_id: number | null;
  seed_id: number | null;
  cambium_seed_id: number | null;
  season: number;
  marked_done_at: string | null;
}

async function events(gardenId: number): Promise<EventRow[]> {
  const { rows } = await pool.query<{
    id: number;
    planting_id: number | null;
    seed_id: number | null;
    cambium_seed_id: number | null;
    season: number;
    marked_done_at: Date | null;
  }>(
    `SELECT id, planting_id, seed_id, cambium_seed_id, season, marked_done_at
     FROM sowing_events WHERE garden_id = $1 ORDER BY id`,
    [gardenId],
  );
  return rows.map((r) => ({ ...r, marked_done_at: r.marked_done_at?.toISOString() ?? null }));
}

describe('syncSowingEvent', () => {
  it('does not count planned plantings, and counts one once it is started', async () => {
    const { ownerId, gardenId, bedId } = await setup();
    const seedId = await createPersonalSeed(ownerId);
    const key: SeedKey = { kind: 'seed', id: seedId };
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO plantings (bed_id, garden_id, season, seed_id, state, cell_x, cell_y)
       VALUES ($1, $2, $3, $4, 'planned', 0, 0) RETURNING id`,
      [bedId, gardenId, SEASON, seedId],
    );
    const plannedId = rows[0].id;

    await syncSowingEventNow(pool, gardenId, key, SEASON);
    expect(await events(gardenId)).toEqual([]);

    await pool.query(
      `UPDATE plantings SET state = 'growing', planting_date = ${PACIFIC_TODAY} - 3 WHERE id = $1`,
      [plannedId],
    );
    await syncSowingEventNow(pool, gardenId, key, SEASON);
    const after = await events(gardenId);
    expect(after).toHaveLength(1);
    expect(after[0].planting_id).toBe(plannedId);
    expect(after[0].marked_done_at).toBe(await noonPacific(3));
  });

  it('un-dones but keeps the event when only planned plantings remain', async () => {
    const { ownerId, gardenId, bedId } = await setup();
    const seedId = await createPersonalSeed(ownerId);
    const key: SeedKey = { kind: 'seed', id: seedId };
    const growing = await createPlanting(bedId, gardenId, { seedId, daysAgo: 4 });
    await syncSowingEventNow(pool, gardenId, key, SEASON);
    await pool.query(
      `INSERT INTO plantings (bed_id, garden_id, season, seed_id, state, cell_x, cell_y)
       VALUES ($1, $2, $3, $4, 'planned', 1, 0)`,
      [bedId, gardenId, SEASON, seedId],
    );

    await pool.query(
      `UPDATE plantings SET state = 'planned', planting_date = NULL WHERE id = $1`,
      [growing],
    );
    await syncSowingEventNow(pool, gardenId, key, SEASON);

    const rows = await events(gardenId);
    expect(rows).toHaveLength(1);
    expect(rows[0].marked_done_at).toBeNull();
  });

  it('inserts a done event, shaped like the guide insert, when none exists', async () => {
    const { ownerId, gardenId, bedId } = await setup();
    const seedId = await createPersonalSeed(ownerId);
    const plantingId = await createPlanting(bedId, gardenId, { seedId, daysAgo: 5 });
    const key: SeedKey = { kind: 'seed', id: seedId };

    await syncSowingEventNow(pool, gardenId, key, SEASON);

    expect(await events(gardenId)).toEqual([
      {
        id: 1,
        planting_id: plantingId,
        seed_id: seedId,
        cambium_seed_id: null,
        season: SEASON,
        marked_done_at: await noonPacific(5),
      },
    ]);
  });

  it('stamps the earliest planting date across two plantings', async () => {
    const { gardenId, bedId } = await setup();
    const cambiumSeedId = await createCambiumSeed();
    await createPlanting(bedId, gardenId, { cambiumSeedId, daysAgo: 3 });
    await createPlanting(bedId, gardenId, { cambiumSeedId, daysAgo: 12 });

    await syncSowingEventNow(pool, gardenId, { kind: 'cambium', id: cambiumSeedId }, SEASON);

    const rows = await events(gardenId);
    expect(rows).toHaveLength(1);
    expect(rows[0].marked_done_at).toBe(await noonPacific(12));
  });

  it('moves the done date when a planting is re-dated, updating the existing event', async () => {
    const { ownerId, gardenId, bedId } = await setup();
    const seedId = await createPersonalSeed(ownerId);
    const plantingId = await createPlanting(bedId, gardenId, { seedId, daysAgo: 10 });
    const key: SeedKey = { kind: 'seed', id: seedId };
    await syncSowingEventNow(pool, gardenId, key, SEASON);

    await pool.query(
      `UPDATE plantings SET planting_date = ${PACIFIC_TODAY} - 2 WHERE id = $1`,
      [plantingId],
    );
    await syncSowingEventNow(pool, gardenId, key, SEASON);

    const rows = await events(gardenId);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(1);
    expect(rows[0].marked_done_at).toBe(await noonPacific(2));
  });

  it('clears the done date but keeps the row when the last planting is deleted', async () => {
    const { ownerId, gardenId, bedId } = await setup();
    const seedId = await createPersonalSeed(ownerId);
    const first = await createPlanting(bedId, gardenId, { seedId, daysAgo: 10 });
    const second = await createPlanting(bedId, gardenId, { seedId, daysAgo: 4 });
    const key: SeedKey = { kind: 'seed', id: seedId };
    await syncSowingEventNow(pool, gardenId, key, SEASON);

    await pool.query('DELETE FROM plantings WHERE id = $1', [first]);
    await syncSowingEventNow(pool, gardenId, key, SEASON);
    expect((await events(gardenId))[0].marked_done_at).toBe(await noonPacific(4));

    await pool.query('DELETE FROM plantings WHERE id = $1', [second]);
    await syncSowingEventNow(pool, gardenId, key, SEASON);

    const rows = await events(gardenId);
    expect(rows).toHaveLength(1);
    expect(rows[0].marked_done_at).toBeNull();
  });

  it('inserts nothing when no plantings exist for the key', async () => {
    const { ownerId, gardenId } = await setup();
    const seedId = await createPersonalSeed(ownerId);

    await syncSowingEventNow(pool, gardenId, { kind: 'seed', id: seedId }, SEASON);

    expect(await events(gardenId)).toEqual([]);
  });

  it('keeps a Cambium-only plant and a personal seed imported from it on separate events', async () => {
    const { ownerId, gardenId, bedId } = await setup();
    const cambiumSeedId = await createCambiumSeed();
    const seedId = await createPersonalSeed(ownerId, cambiumSeedId);
    await createPlanting(bedId, gardenId, { cambiumSeedId, daysAgo: 20 });
    await createPlanting(bedId, gardenId, { seedId, cambiumSeedId, daysAgo: 6 });

    await syncSowingEventNow(pool, gardenId, { kind: 'cambium', id: cambiumSeedId }, SEASON);
    await syncSowingEventNow(pool, gardenId, { kind: 'seed', id: seedId }, SEASON);

    const rows = await events(gardenId);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      seed_id: null,
      cambium_seed_id: cambiumSeedId,
      marked_done_at: await noonPacific(20),
    });
    expect(rows[1]).toMatchObject({
      seed_id: seedId,
      cambium_seed_id: null,
      marked_done_at: await noonPacific(6),
    });
  });
});

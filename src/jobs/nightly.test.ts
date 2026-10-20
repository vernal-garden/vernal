import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { Pool } from 'pg';

vi.mock('../lib/r2', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/r2')>()),
  uploadToR2: vi.fn(),
  getPresignedDownloadUrl: vi.fn(),
  deleteFromR2: vi.fn(),
  deletePrefixFromR2: vi.fn(),
  exportsBucket: vi.fn(() => 'test-exports'),
}));

vi.mock('../lib/billing', () => ({
  stopRenewal: vi.fn(),
  resumeRenewal: vi.fn(),
  teardownCustomer: vi.fn(),
}));

import { deleteFromR2, exportsBucket } from '../lib/r2';
import { teardownCustomer } from '../lib/billing';
import { currentSeason } from '../lib/season';
import {
  deriveGrowth,
  refreshGardenBadges,
  purgeExpiredGuests,
  purgeReadNotifications,
  purgeStripeEvents,
  purgeScheduledAccounts,
  checkSubscriptionDowngrades,
  purgeExpiredExports,
  runNightlyJob,
} from './nightly';

const deleteFromR2Mock = vi.mocked(deleteFromR2);
const exportsBucketMock = vi.mocked(exportsBucket);
const teardownCustomerMock = vi.mocked(teardownCustomer);

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL must be set to run tests');

const pool = new Pool({ connectionString: url });

const CURRENT_YEAR = currentSeason();

async function resetDb() {
  await pool.query(
    `TRUNCATE accounts, guest_sessions, gardens, beds, plantings, seeds, seed_photos, harvest_entries,
       data_export_jobs, password_reset_tokens, job_runs, r2_deletions RESTART IDENTITY CASCADE`,
  );
  await pool.query('TRUNCATE cambium.seeds, cambium.companions RESTART IDENTITY CASCADE');
}

async function queued() {
  const { rows } = await pool.query<{ bucket: string; path: string; is_prefix: boolean }>(
    'SELECT bucket, path, is_prefix FROM r2_deletions ORDER BY id',
  );
  return rows;
}

let emailCounter = 0;

async function createAccount(
  overrides: {
    subscriptionTier?: string;
    stripeSubscriptionId?: string | null;
    subscriptionInterval?: string | null;
    subscriptionPeriodEndDaysAgo?: number;
    deletionScheduledAtDaysAgo?: number;
  } = {},
): Promise<number> {
  emailCounter += 1;
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO accounts
       (email, zone, zone_location_label, subscription_tier, stripe_subscription_id,
        subscription_interval, subscription_period_end, deletion_scheduled_at)
     VALUES (
       $1, '7b', 'Test City', $2, $3, $4,
       CASE WHEN $5::numeric IS NULL THEN NULL ELSE NOW() - ($5::text || ' days')::interval END,
       CASE WHEN $6::numeric IS NULL THEN NULL ELSE NOW() - ($6::text || ' days')::interval END
     )
     RETURNING id`,
    [
      `nightly-user-${emailCounter}@example.com`,
      overrides.subscriptionTier ?? 'free',
      overrides.stripeSubscriptionId ?? null,
      overrides.subscriptionInterval ?? null,
      overrides.subscriptionPeriodEndDaysAgo ?? null,
      overrides.deletionScheduledAtDaysAgo ?? null,
    ],
  );
  return rows[0].id;
}

async function createGarden(ownerId: number): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO gardens (owner_id, name, style, zone)
     VALUES ($1, 'Nightly Test Garden', 'grid', '7b')
     RETURNING id`,
    [ownerId],
  );
  return rows[0].id;
}

async function createBed(gardenId: number): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO beds (garden_id, season, type, grid_x, grid_y, grid_cols, grid_rows)
     VALUES ($1, $2, 'grid', 0, 0, 4, 4)
     RETURNING id`,
    [gardenId, CURRENT_YEAR],
  );
  return rows[0].id;
}

async function createCambiumSeed(): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO cambium.seeds (common_name, source)
     VALUES ('Nightly Test Plant', 'editorial')
     RETURNING id`,
  );
  return rows[0].id;
}

async function createPersonalSeed(
  ownerId: number,
  maturityDaysMax: number | null,
  maturityDaysMin: number | null = null,
): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO seeds
       (owner_id, common_name, origin, contribution_status, maturity_days_max, maturity_days_min)
     VALUES ($1, 'Nightly Test Plant', 'user_created', 'private', $2, $3)
     RETURNING id`,
    [ownerId, maturityDaysMax, maturityDaysMin],
  );
  return rows[0].id;
}

// "N days ago" is measured in Pacific time, matching the job's notion of today.
const PACIFIC_TODAY = `(NOW() AT TIME ZONE 'America/Los_Angeles')::date`;

async function createPlanting(
  bedId: number,
  gardenId: number,
  overrides: {
    seedId?: number | null;
    cambiumSeedId?: number | null;
    plantingDateDaysAgo?: number | null;
    plantingDate?: string; // YYYY-MM-DD; overrides plantingDateDaysAgo
    indicatorDismissed?: boolean;
    season?: number;
  } = {},
): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO plantings
       (bed_id, garden_id, season, seed_id, cambium_seed_id, planting_date, indicator_dismissed_at, cell_x, cell_y)
     VALUES ($1, $2, $3, $4, $5,
             COALESCE($8::date,
               CASE WHEN $6::int IS NULL THEN NULL ELSE ${PACIFIC_TODAY} - $6::int END),
             CASE WHEN $7::bool THEN NOW() ELSE NULL END,
             -- COUNT-derived cell_x only satisfies the one-per-cell unique index
             -- (this suite never deletes plantings mid-test).
             (SELECT COUNT(*)::int FROM plantings WHERE bed_id = $1), 0)
     RETURNING id`,
    [
      bedId,
      gardenId,
      overrides.season ?? CURRENT_YEAR,
      overrides.seedId ?? null,
      overrides.cambiumSeedId ?? null,
      overrides.plantingDateDaysAgo ?? null,
      overrides.indicatorDismissed ?? false,
      overrides.plantingDate ?? null,
    ],
  );
  return rows[0].id;
}

// markedDoneDaysAgo null leaves the event not done. A done event is stamped at
// noon Pacific on that day so it can't straddle a date boundary.
async function createSowingEvent(
  gardenId: number,
  overrides: {
    seedId?: number | null;
    cambiumSeedId?: number | null;
    season?: number;
    markedDoneDaysAgo?: number | null;
  } = {},
): Promise<void> {
  await pool.query(
    `INSERT INTO sowing_events (garden_id, seed_id, cambium_seed_id, season, marked_done_at)
     VALUES ($1, $2, $3, $4,
             CASE WHEN $5::int IS NULL THEN NULL
                  ELSE (${PACIFIC_TODAY} - $5::int + TIME '12:00') AT TIME ZONE 'America/Los_Angeles'
             END)`,
    [
      gardenId,
      overrides.seedId ?? null,
      overrides.cambiumSeedId ?? null,
      overrides.season ?? CURRENT_YEAR,
      overrides.markedDoneDaysAgo === undefined ? 0 : overrides.markedDoneDaysAgo,
    ],
  );
}

// YYYY-MM-DD for the Pacific date `offsetDays` from today.
async function pacificDateKey(offsetDays: number): Promise<string> {
  const { rows } = await pool.query<{ d: string }>(
    `SELECT (${PACIFIC_TODAY} + $1::int)::text AS d`,
    [offsetDays],
  );
  return rows[0].d;
}

async function readGrowth(plantingId: number) {
  const { rows } = await pool.query(
    `SELECT growth_stage_pct, growth_stage, displayed_growth_stage, harvest_ready,
            harvest_window_end::text AS harvest_window_end
     FROM plantings WHERE id = $1`,
    [plantingId],
  );
  const row = rows[0];
  return {
    pct: row.growth_stage_pct === null ? null : Number(row.growth_stage_pct),
    stage: row.growth_stage as number | null,
    displayedStage: row.displayed_growth_stage as number | null,
    harvestReady: row.harvest_ready as boolean,
    windowEnd: row.harvest_window_end as string | null,
  };
}

afterAll(() => pool.end());

describe('deriveGrowth', () => {
  beforeEach(resetDb);

  async function setup() {
    const ownerId = await createAccount();
    const gardenId = await createGarden(ownerId);
    const bedId = await createBed(gardenId);
    return { ownerId, gardenId, bedId };
  }

  it('marks an anchored planting at 100% maturity harvest-ready with growth_stage 5', async () => {
    const { ownerId, gardenId, bedId } = await setup();
    const seedId = await createPersonalSeed(ownerId, 60);
    const plantingId = await createPlanting(bedId, gardenId, { seedId, plantingDateDaysAgo: 60 });
    await createSowingEvent(gardenId, { seedId });

    await deriveGrowth();

    const row = await readGrowth(plantingId);
    expect(row.pct).toBe(100);
    expect(row.stage).toBe(5);
    expect(row.harvestReady).toBe(true);
    expect(row.windowEnd).toBe(await pacificDateKey(-60 + 60 + 14));
  });

  it('marks an anchored planting at 50% maturity as growth_stage 3 and not harvest-ready', async () => {
    const { ownerId, gardenId, bedId } = await setup();
    const seedId = await createPersonalSeed(ownerId, 60);
    const plantingId = await createPlanting(bedId, gardenId, { seedId, plantingDateDaysAgo: 30 });
    await createSowingEvent(gardenId, { seedId });

    await deriveGrowth();

    const row = await readGrowth(plantingId);
    expect(row.pct).toBe(50);
    expect(row.stage).toBe(3);
    expect(row.harvestReady).toBe(false);
  });

  it('clears growth fields for a planting with a planting_date but no done sowing event', async () => {
    const { ownerId, gardenId, bedId } = await setup();
    const seedId = await createPersonalSeed(ownerId, 60);
    const plantingId = await createPlanting(bedId, gardenId, { seedId, plantingDateDaysAgo: 60 });
    await createSowingEvent(gardenId, { seedId, markedDoneDaysAgo: null });
    // Stale values from an earlier run must be reset, not left behind.
    await pool.query(
      `UPDATE plantings SET growth_stage_pct = 80, growth_stage = 4, harvest_ready = true,
         harvest_window_end = CURRENT_DATE WHERE id = $1`,
      [plantingId],
    );

    await deriveGrowth();

    const row = await readGrowth(plantingId);
    expect(row.pct).toBeNull();
    expect(row.stage).toBeNull();
    expect(row.harvestReady).toBe(false);
    expect(row.windowEnd).toBeNull();
  });

  it('ignores done sowing events for another season or another seed', async () => {
    const { ownerId, gardenId, bedId } = await setup();
    const seedId = await createPersonalSeed(ownerId, 60);
    const otherSeedId = await createPersonalSeed(ownerId, 60);
    const plantingId = await createPlanting(bedId, gardenId, { seedId, plantingDateDaysAgo: 30 });
    await createSowingEvent(gardenId, { seedId, season: CURRENT_YEAR - 1 });
    await createSowingEvent(gardenId, { seedId: otherSeedId });

    await deriveGrowth();

    const row = await readGrowth(plantingId);
    expect(row.pct).toBeNull();
    expect(row.stage).toBeNull();
  });

  it('does not anchor a personal-seed planting on a done event that only has its Cambium id', async () => {
    const { ownerId, gardenId, bedId } = await setup();
    const seedId = await createPersonalSeed(ownerId, 60);
    const cambiumSeedId = await createCambiumSeed();
    const plantingId = await createPlanting(bedId, gardenId, {
      seedId,
      cambiumSeedId,
      plantingDateDaysAgo: 30,
    });
    await createSowingEvent(gardenId, { cambiumSeedId });

    await deriveGrowth();

    const row = await readGrowth(plantingId);
    expect(row.pct).toBeNull();
    expect(row.stage).toBeNull();
  });

  it('anchors on planting_date when it is set, not on the sowing event date', async () => {
    const { ownerId, gardenId, bedId } = await setup();
    const seedId = await createPersonalSeed(ownerId, 60);
    const plantingId = await createPlanting(bedId, gardenId, { seedId, plantingDateDaysAgo: 30 });
    await createSowingEvent(gardenId, { seedId, markedDoneDaysAgo: 3 });

    await deriveGrowth();

    const row = await readGrowth(plantingId);
    expect(row.pct).toBe(50);
    expect(row.windowEnd).toBe(await pacificDateKey(-30 + 60 + 14));
  });

  it('anchors on the earliest done sowing event (Pacific date) when planting_date is null', async () => {
    const { gardenId, bedId } = await setup();
    const cambiumSeedId = await createCambiumSeed();
    await pool.query(`UPDATE cambium.seeds SET maturity_days_max = 60 WHERE id = $1`, [
      cambiumSeedId,
    ]);
    const plantingId = await createPlanting(bedId, gardenId, {
      cambiumSeedId,
      plantingDateDaysAgo: null,
    });
    await createSowingEvent(gardenId, { cambiumSeedId, markedDoneDaysAgo: 10 });
    await createSowingEvent(gardenId, { cambiumSeedId, markedDoneDaysAgo: 30 });

    await deriveGrowth();

    const row = await readGrowth(plantingId);
    expect(row.pct).toBe(50);
    expect(row.stage).toBe(3);
    expect(row.windowEnd).toBe(await pacificDateKey(-30 + 60 + 14));
  });

  it('uses maturity_days_min for progress and maturity_days_max for the harvest window', async () => {
    const { ownerId, gardenId, bedId } = await setup();
    const seedId = await createPersonalSeed(ownerId, 70, 50);
    const plantingId = await createPlanting(bedId, gardenId, { seedId, plantingDateDaysAgo: 50 });
    await createSowingEvent(gardenId, { seedId });

    await deriveGrowth();

    const row = await readGrowth(plantingId);
    expect(row.pct).toBe(100);
    expect(row.stage).toBe(5);
    expect(row.harvestReady).toBe(true);
    expect(row.windowEnd).toBe(await pacificDateKey(-50 + 70 + 14));
  });

  it('maps 30% to stage 3 and 70% to stage 4', async () => {
    const { ownerId, gardenId, bedId } = await setup();
    const seedId = await createPersonalSeed(ownerId, null, 100);
    const at30 = await createPlanting(bedId, gardenId, { seedId, plantingDateDaysAgo: 30 });
    const at70 = await createPlanting(bedId, gardenId, { seedId, plantingDateDaysAgo: 70 });
    await createSowingEvent(gardenId, { seedId });

    await deriveGrowth();

    const row30 = await readGrowth(at30);
    expect(row30.pct).toBe(30);
    expect(row30.stage).toBe(3);
    const row70 = await readGrowth(at70);
    expect(row70.pct).toBe(70);
    expect(row70.stage).toBe(4);
    expect(row70.harvestReady).toBe(false);
  });

  it('leaves growth fields null when the seed has no maturity days', async () => {
    const { ownerId, gardenId, bedId } = await setup();
    const seedId = await createPersonalSeed(ownerId, null);
    const plantingId = await createPlanting(bedId, gardenId, { seedId, plantingDateDaysAgo: 10 });
    await createSowingEvent(gardenId, { seedId });

    await deriveGrowth();

    const row = await readGrowth(plantingId);
    expect(row.pct).toBeNull();
    expect(row.stage).toBeNull();
    expect(row.harvestReady).toBe(false);
    expect(row.windowEnd).toBeNull();
  });

  it('keeps stage 5 but harvest_ready false when indicator_dismissed_at is set', async () => {
    const { ownerId, gardenId, bedId } = await setup();
    const seedId = await createPersonalSeed(ownerId, 60);
    const plantingId = await createPlanting(bedId, gardenId, {
      seedId,
      plantingDateDaysAgo: 60,
      indicatorDismissed: true,
    });
    await createSowingEvent(gardenId, { seedId });

    await deriveGrowth();

    const row = await readGrowth(plantingId);
    expect(row.stage).toBe(5);
    expect(row.harvestReady).toBe(false);
  });

  it('never marks a previous-season planting harvest-ready', async () => {
    const { ownerId, gardenId, bedId } = await setup();
    const seedId = await createPersonalSeed(ownerId, 60);
    // Mid-June of last season: inside CURRENT_YEAR - 1 and well past 60 days ago.
    const plantingId = await createPlanting(bedId, gardenId, {
      seedId,
      plantingDate: `${CURRENT_YEAR - 1}-06-15`,
      season: CURRENT_YEAR - 1,
    });
    await createSowingEvent(gardenId, { seedId, season: CURRENT_YEAR - 1 });

    await deriveGrowth();

    const row = await readGrowth(plantingId);
    expect(row.pct).toBe(100);
    expect(row.stage).toBe(5);
    expect(row.harvestReady).toBe(false);
  });

  it('leaves unchanged plantings untouched on a second run', async () => {
    const { ownerId, gardenId, bedId } = await setup();
    const seedId = await createPersonalSeed(ownerId, 60);
    const anchored = await createPlanting(bedId, gardenId, { seedId, plantingDateDaysAgo: 30 });
    const unanchored = await createPlanting(bedId, gardenId, {
      seedId: await createPersonalSeed(ownerId, 60),
      plantingDateDaysAgo: 30,
    });
    await createSowingEvent(gardenId, { seedId });

    const first = await deriveGrowth();
    expect(first.affected).toBe(1);
    const readUpdatedAt = async () => {
      const { rows } = await pool.query<{ id: number; updated_at: Date }>(
        `SELECT id, updated_at FROM plantings WHERE id = ANY($1::int[]) ORDER BY id`,
        [[anchored, unanchored]],
      );
      return rows.map((r) => r.updated_at.toISOString());
    };
    const before = await readUpdatedAt();

    const second = await deriveGrowth();

    expect(second.affected).toBe(0);
    expect(await readUpdatedAt()).toEqual(before);
  });

  it('does not write displayed_growth_stage', async () => {
    const { ownerId, gardenId, bedId } = await setup();
    const seedId = await createPersonalSeed(ownerId, 60);
    const anchored = await createPlanting(bedId, gardenId, { seedId, plantingDateDaysAgo: 60 });
    const unanchored = await createPlanting(bedId, gardenId, {
      seedId: await createPersonalSeed(ownerId, 60),
      plantingDateDaysAgo: 60,
    });
    await createSowingEvent(gardenId, { seedId });
    await pool.query(
      `UPDATE plantings SET displayed_growth_stage = 2 WHERE id = ANY($1::int[])`,
      [[anchored, unanchored]],
    );

    await deriveGrowth();

    const anchoredRow = await readGrowth(anchored);
    expect(anchoredRow.stage).toBe(5);
    expect(anchoredRow.displayedStage).toBe(2);
    expect((await readGrowth(unanchored)).displayedStage).toBe(2);
  });
});

describe('refreshGardenBadges', () => {
  beforeEach(resetDb);

  it('counts harvest-ready, non-dismissed plantings per garden', async () => {
    const ownerId = await createAccount();
    const gardenA = await createGarden(ownerId);
    const gardenB = await createGarden(ownerId);
    const bedA = await createBed(gardenA);
    const bedB = await createBed(gardenB);
    const cambiumSeedId = await createCambiumSeed();

    const pA1 = await createPlanting(bedA, gardenA, { cambiumSeedId });
    const pA2 = await createPlanting(bedA, gardenA, { cambiumSeedId });
    await createPlanting(bedA, gardenA, { cambiumSeedId }); // control: stays not harvest-ready
    const pB1 = await createPlanting(bedB, gardenB, { cambiumSeedId });

    await pool.query(`UPDATE plantings SET harvest_ready = true WHERE id = ANY($1::int[])`, [
      [pA1, pA2, pB1],
    ]);

    await refreshGardenBadges();

    const { rows } = await pool.query<{ id: number; harvestable_count: number }>(
      `SELECT id, harvestable_count FROM gardens WHERE id = ANY($1::int[])`,
      [[gardenA, gardenB]],
    );
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.harvestable_count]));
    expect(byId[gardenA]).toBe(2);
    expect(byId[gardenB]).toBe(1);
  });

  it('flags has_companion_warnings only for antagonistic pairs at or above the confidence threshold', async () => {
    const ownerId = await createAccount();

    async function insertCompanion(
      seedId: number,
      companionSeedId: number,
      relationship: 'beneficial' | 'antagonistic' | 'neutral',
      confidence: number,
    ) {
      await pool.query(
        `INSERT INTO cambium.companions (seed_id, companion_seed_id, relationship, confidence)
         VALUES ($1, $2, $3, $4)`,
        [seedId, companionSeedId, relationship, confidence],
      );
    }

    async function gardenWith(first: number, second: number): Promise<number> {
      const gardenId = await createGarden(ownerId);
      const bedId = await createBed(gardenId);
      await createPlanting(bedId, gardenId, { cambiumSeedId: first });
      await createPlanting(bedId, gardenId, { cambiumSeedId: second });
      return gardenId;
    }

    // Forward: row stored as (p1 seed -> p2 seed), at exactly the threshold.
    const fwdA = await createCambiumSeed();
    const fwdB = await createCambiumSeed();
    await insertCompanion(fwdA, fwdB, 'antagonistic', 40);
    const gardenForward = await gardenWith(fwdA, fwdB);

    // Reverse: row stored as (p2 seed -> p1 seed).
    const revA = await createCambiumSeed();
    const revB = await createCambiumSeed();
    await insertCompanion(revB, revA, 'antagonistic', 80);
    const gardenReverse = await gardenWith(revA, revB);

    // Antagonistic but below threshold.
    const lowA = await createCambiumSeed();
    const lowB = await createCambiumSeed();
    await insertCompanion(lowA, lowB, 'antagonistic', 39);
    const gardenLowConfidence = await gardenWith(lowA, lowB);

    // Beneficial at high confidence.
    const benA = await createCambiumSeed();
    const benB = await createCambiumSeed();
    await insertCompanion(benA, benB, 'beneficial', 90);
    const gardenBeneficial = await gardenWith(benA, benB);

    await refreshGardenBadges();

    const { rows } = await pool.query<{ id: number; has_companion_warnings: boolean }>(
      `SELECT id, has_companion_warnings FROM gardens WHERE id = ANY($1::int[])`,
      [[gardenForward, gardenReverse, gardenLowConfidence, gardenBeneficial]],
    );
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.has_companion_warnings]));
    expect(byId[gardenForward]).toBe(true);
    expect(byId[gardenReverse]).toBe(true);
    expect(byId[gardenLowConfidence]).toBe(false);
    expect(byId[gardenBeneficial]).toBe(false);
  });
});

describe('purgeExpiredGuests', () => {
  const BASE = 'https://cdn.example.com';
  let savedBaseUrl: string | undefined;

  beforeEach(async () => {
    await resetDb();
    deleteFromR2Mock.mockReset().mockResolvedValue(undefined);
    savedBaseUrl = process.env.R2_PUBLIC_BASE_URL;
    process.env.R2_PUBLIC_BASE_URL = BASE;
  });

  afterEach(() => {
    if (savedBaseUrl === undefined) delete process.env.R2_PUBLIC_BASE_URL;
    else process.env.R2_PUBLIC_BASE_URL = savedBaseUrl;
  });

  async function createGuestWithThumbnail(
    token: string,
    opts: { migratedToAccountId?: number; thumbnail?: boolean } = {},
  ): Promise<{ sessionId: string; gardenId: number }> {
    const { rows: sessions } = await pool.query<{ id: string }>(
      `INSERT INTO guest_sessions (token, expires_at, migrated_at, account_id)
       VALUES ($1, NOW() - INTERVAL '1 day',
               CASE WHEN $2::int IS NULL THEN NULL ELSE NOW() END, $2::int)
       RETURNING id`,
      [token, opts.migratedToAccountId ?? null],
    );
    const sessionId = sessions[0].id;
    const { rows: gardens } = await pool.query<{ id: number }>(
      `INSERT INTO gardens (guest_session_id, name, style, zone)
       VALUES ($1, 'Guest garden', 'grid', '7a') RETURNING id`,
      [sessionId],
    );
    const gardenId = gardens[0].id;
    if (opts.thumbnail !== false) {
      await pool.query(`UPDATE gardens SET thumbnail_url = $1 WHERE id = $2`, [
        `${BASE}/garden-thumbnails/${gardenId}/x.png`,
        gardenId,
      ]);
    }
    return { sessionId, gardenId };
  }

  async function sessionIds(): Promise<string[]> {
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM guest_sessions');
    return rows.map((r) => r.id);
  }

  async function gardenIds(): Promise<number[]> {
    const { rows } = await pool.query<{ id: number }>('SELECT id FROM gardens');
    return rows.map((r) => r.id);
  }

  it('queues the thumbnail folder of an expired guest and deletes the session', async () => {
    const { sessionId, gardenId } = await createGuestWithThumbnail('nightly-guest-thumb');

    const { affected } = await purgeExpiredGuests();

    expect(affected).toBe(1);
    expect(await queued()).toEqual([
      { bucket: 'public', path: `garden-thumbnails/${gardenId}/`, is_prefix: true },
    ]);
    expect(deleteFromR2Mock).not.toHaveBeenCalled();
    expect(await sessionIds()).not.toContain(sessionId);
    expect(await gardenIds()).not.toContain(gardenId);
  });

  it('queues nothing for an expired guest garden without a thumbnail', async () => {
    const { sessionId, gardenId } = await createGuestWithThumbnail('nightly-guest-nothumb', {
      thumbnail: false,
    });

    const { affected } = await purgeExpiredGuests();

    expect(affected).toBe(1);
    expect(await queued()).toEqual([]);
    expect(await sessionIds()).not.toContain(sessionId);
    expect(await gardenIds()).not.toContain(gardenId);
  });

  it('does not touch a migrated guest session or its thumbnail', async () => {
    const ownerId = await createAccount();
    const { sessionId, gardenId } = await createGuestWithThumbnail('nightly-guest-migrated', {
      migratedToAccountId: ownerId,
    });

    await purgeExpiredGuests();

    expect(await queued()).toEqual([]);
    expect(await sessionIds()).toContain(sessionId);
    expect(await gardenIds()).toContain(gardenId);
  });

  it('deletes expired non-migrated sessions but keeps expired migrated sessions', async () => {
    const ownerId = await createAccount();
    await pool.query(
      `INSERT INTO guest_sessions (token, expires_at, migrated_at)
       VALUES ('nightly-expired-not-migrated', NOW() - INTERVAL '1 day', NULL)`,
    );
    await pool.query(
      `INSERT INTO guest_sessions (token, expires_at, migrated_at, account_id)
       VALUES ('nightly-expired-migrated', NOW() - INTERVAL '1 day', NOW(), $1)`,
      [ownerId],
    );

    await purgeExpiredGuests();

    const { rows } = await pool.query<{ token: string }>('SELECT token FROM guest_sessions');
    const tokens = rows.map((r) => r.token);
    expect(tokens).not.toContain('nightly-expired-not-migrated');
    expect(tokens).toContain('nightly-expired-migrated');
  });

  it('deletes expired email verification tokens and keeps live ones', async () => {
    const ownerId = await createAccount();
    await pool.query(
      `INSERT INTO email_verification_tokens (account_id, email, token_hash, expires_at)
       VALUES ($1, 'v@example.com', 'nightly-vt-expired', NOW() - INTERVAL '1 hour'),
              ($1, 'v@example.com', 'nightly-vt-live', NOW() + INTERVAL '1 hour')`,
      [ownerId],
    );

    const { affected } = await purgeExpiredGuests();

    expect(affected).toBe(1);
    const { rows } = await pool.query<{ token_hash: string }>(
      'SELECT token_hash FROM email_verification_tokens',
    );
    expect(rows.map((r) => r.token_hash)).toEqual(['nightly-vt-live']);
  });
});

describe('purgeExpiredGuests — empty guests and batching', () => {
  beforeEach(async () => {
    await resetDb();
    await pool.query('TRUNCATE email_change_tokens');
    deleteFromR2Mock.mockReset().mockResolvedValue(undefined);
  });

  let tokenCounter = 0;
  async function insertGuest(createdAgo: string, opts: { expired?: boolean; migratedTo?: number } = {}) {
    tokenCounter += 1;
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO guest_sessions (token, created_at, expires_at, migrated_at, account_id)
       VALUES ($1, NOW() - $2::interval,
               CASE WHEN $3::boolean THEN NOW() - INTERVAL '1 hour' ELSE NOW() + INTERVAL '20 days' END,
               CASE WHEN $4::int IS NULL THEN NULL ELSE NOW() END, $4::int)
       RETURNING id`,
      [`empty-guest-${tokenCounter}`, createdAgo, opts.expired ?? false, opts.migratedTo ?? null],
    );
    return rows[0].id;
  }

  async function existingIds(): Promise<string[]> {
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM guest_sessions');
    return rows.map((r) => r.id);
  }

  it('deletes a guest older than 2 days that owns nothing', async () => {
    const id = await insertGuest('3 days');
    const { affected } = await purgeExpiredGuests();
    expect(affected).toBe(1);
    expect(await existingIds()).not.toContain(id);
  });

  it('keeps an old guest that has a garden', async () => {
    const id = await insertGuest('3 days');
    await pool.query(
      `INSERT INTO gardens (guest_session_id, name, style, zone) VALUES ($1, 'Kept', 'grid', '7a')`,
      [id],
    );
    await purgeExpiredGuests();
    expect(await existingIds()).toContain(id);
  });

  it('keeps an old guest that has a seed', async () => {
    const id = await insertGuest('3 days');
    await pool.query(
      `INSERT INTO seeds (guest_session_id, common_name, origin) VALUES ($1, 'Tomato', 'user_created')`,
      [id],
    );
    await purgeExpiredGuests();
    expect(await existingIds()).toContain(id);
  });

  it('keeps an empty guest younger than 2 days', async () => {
    const id = await insertGuest('1 day');
    await purgeExpiredGuests();
    expect(await existingIds()).toContain(id);
  });

  it('keeps an old session that belongs to an account', async () => {
    const accountId = await createAccount();
    const id = await insertGuest('3 days', { migratedTo: accountId });
    await purgeExpiredGuests();
    expect(await existingIds()).toContain(id);
  });

  it('works through more empty guests than one batch', async () => {
    for (let i = 0; i < 5; i++) await insertGuest('3 days');
    const { affected } = await purgeExpiredGuests({ batchSize: 2 });
    expect(affected).toBe(5);
    expect(await existingIds()).toHaveLength(0);
  });

  it('works through more expired guests than one batch', async () => {
    const BASE = 'https://cdn.example.com';
    const saved = process.env.R2_PUBLIC_BASE_URL;
    process.env.R2_PUBLIC_BASE_URL = BASE;
    try {
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const id = await insertGuest('1 hour', { expired: true });
        const { rows } = await pool.query<{ id: number }>(
          `INSERT INTO gardens (guest_session_id, name, style, zone) VALUES ($1, 'G', 'grid', '7a') RETURNING id`,
          [id],
        );
        await pool.query('UPDATE gardens SET thumbnail_url = $1 WHERE id = $2', [
          `${BASE}/garden-thumbnails/${rows[0].id}/x.png`,
          rows[0].id,
        ]);
        ids.push(id);
      }

      const { affected } = await purgeExpiredGuests({ batchSize: 1 });

      expect(affected).toBe(3);
      expect(await existingIds()).toHaveLength(0);
      expect(await queued()).toHaveLength(3);
    } finally {
      if (saved === undefined) delete process.env.R2_PUBLIC_BASE_URL;
      else process.env.R2_PUBLIC_BASE_URL = saved;
    }
  });

  it('drops email-change tokens older than 30 days and keeps newer ones', async () => {
    const accountId = await createAccount();
    await pool.query(
      `INSERT INTO email_change_tokens (account_id, token_hash, new_email, expires_at, created_at, used_at)
       VALUES ($1, 'old-hash', 'old@example.com', NOW() - INTERVAL '30 days', NOW() - INTERVAL '31 days', NOW()),
              ($1, 'new-hash', 'new@example.com', NOW() + INTERVAL '1 day', NOW() - INTERVAL '1 day', NULL)`,
      [accountId],
    );
    await purgeExpiredGuests();
    const { rows } = await pool.query<{ token_hash: string }>('SELECT token_hash FROM email_change_tokens');
    expect(rows.map((r) => r.token_hash)).toEqual(['new-hash']);
  });
});

describe('purgeReadNotifications', () => {
  beforeEach(resetDb);

  it('deletes notifications read over 90 days ago, keeping unread and recently read ones', async () => {
    const accountId = await createAccount();
    const insert = async (readDaysAgo: number | null, createdDaysAgo: number) => {
      const { rows } = await pool.query<{ id: number }>(
        `INSERT INTO notifications (account_id, type, read_at, created_at)
         VALUES ($1, 'contribution_approved',
                 CASE WHEN $2::int IS NULL THEN NULL ELSE NOW() - make_interval(days => $2::int) END,
                 NOW() - make_interval(days => $3::int))
         RETURNING id`,
        [accountId, readDaysAgo, createdDaysAgo],
      );
      return rows[0].id;
    };
    const oldRead = await insert(91, 100);
    const oldUnread = await insert(null, 100);
    const recentRead = await insert(10, 20);

    const { affected } = await purgeReadNotifications();

    expect(affected).toBe(1);
    const { rows } = await pool.query<{ id: number }>('SELECT id FROM notifications');
    const ids = rows.map((r) => r.id);
    expect(ids).not.toContain(oldRead);
    expect(ids).toContain(oldUnread);
    expect(ids).toContain(recentRead);
  });
});

describe('purgeScheduledAccounts', () => {
  const BASE = 'https://cdn.example.com';
  let savedBaseUrl: string | undefined;

  beforeEach(async () => {
    await resetDb();
    deleteFromR2Mock.mockReset().mockResolvedValue(undefined);
    exportsBucketMock.mockReset().mockReturnValue('test-exports');
    teardownCustomerMock.mockReset().mockResolvedValue(undefined);
    savedBaseUrl = process.env.R2_PUBLIC_BASE_URL;
    process.env.R2_PUBLIC_BASE_URL = BASE;
  });

  afterEach(() => {
    if (savedBaseUrl === undefined) delete process.env.R2_PUBLIC_BASE_URL;
    else process.env.R2_PUBLIC_BASE_URL = savedBaseUrl;
  });

  it('tears down the Stripe customer before deleting the account', async () => {
    const id = await createAccount({ deletionScheduledAtDaysAgo: 31, stripeSubscriptionId: 'sub_purge' });
    await pool.query("UPDATE accounts SET stripe_customer_id = 'cus_purge' WHERE id = $1", [id]);

    const { affected } = await purgeScheduledAccounts();
    expect(affected).toBe(1);
    expect(teardownCustomerMock).toHaveBeenCalledWith({ subId: 'sub_purge', customerId: 'cus_purge' });
  });

  it('keeps the account when Stripe teardown fails', async () => {
    const id = await createAccount({ deletionScheduledAtDaysAgo: 31 });
    await pool.query("UPDATE accounts SET stripe_customer_id = 'cus_keep' WHERE id = $1", [id]);
    teardownCustomerMock.mockRejectedValueOnce(new Error('stripe down'));

    const { affected } = await purgeScheduledAccounts();
    expect(affected).toBe(0);
    expect(await accountIds()).toContain(id);
    expect(await queued()).toEqual([]);
  });

  it('keeps the account when its deletion is cancelled between the scan and the purge', async () => {
    const id = await createAccount({ deletionScheduledAtDaysAgo: 31 });
    await createPersonalSeed(id, 60);
    teardownCustomerMock.mockImplementationOnce(async () => {
      await pool.query('UPDATE accounts SET deletion_scheduled_at = NULL WHERE id = $1', [id]);
    });

    const { affected } = await purgeScheduledAccounts();
    expect(affected).toBe(0);
    expect(await accountIds()).toContain(id);
    expect(await queued()).toEqual([]);
  });

  it('purges the other accounts in a batch when one teardown fails', async () => {
    const first = await createAccount({ deletionScheduledAtDaysAgo: 31 });
    const second = await createAccount({ deletionScheduledAtDaysAgo: 31 });
    await pool.query("UPDATE accounts SET stripe_customer_id = 'cus_first' WHERE id = $1", [first]);
    await pool.query("UPDATE accounts SET stripe_customer_id = 'cus_second' WHERE id = $1", [second]);
    teardownCustomerMock.mockImplementation(async ({ customerId }) => {
      if (customerId === 'cus_first') throw new Error('stripe down');
    });

    const { affected } = await purgeScheduledAccounts();
    expect(affected).toBe(1);
    const ids = await accountIds();
    expect(ids).toContain(first);
    expect(ids).not.toContain(second);
  });

  async function createSeedPhoto(seedId: number, key: string): Promise<void> {
    await pool.query(
      `INSERT INTO seed_photos (seed_id, storage_url, r2_key) VALUES ($1, $2, $3)`,
      [seedId, `${BASE}/${key}`, key],
    );
  }

  async function createHarvestEntry(gardenId: number, keys: string[]): Promise<number> {
    const photos = keys.map((key) => ({ key, url: `${BASE}/${key}` }));
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO harvest_entries (garden_id, photos) VALUES ($1, $2::jsonb) RETURNING id`,
      [gardenId, JSON.stringify(photos)],
    );
    return rows[0].id;
  }

  async function createExportJob(accountId: number, status = 'complete'): Promise<number> {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO data_export_jobs (account_id, status) VALUES ($1, $2) RETURNING id`,
      [accountId, status],
    );
    return rows[0].id;
  }

  async function accountIds(): Promise<number[]> {
    const { rows } = await pool.query<{ id: number }>('SELECT id FROM accounts');
    return rows.map((r) => r.id);
  }

  it('deletes accounts 31 days past their scheduled deletion but keeps ones 29 days past', async () => {
    const idPastGrace = await createAccount({ deletionScheduledAtDaysAgo: 31 });
    const idWithinGrace = await createAccount({ deletionScheduledAtDaysAgo: 29 });

    await purgeScheduledAccounts();

    const ids = await accountIds();
    expect(ids).not.toContain(idPastGrace);
    expect(ids).toContain(idWithinGrace);
  });

  it('queues every folder the account owns in the same transaction as the delete', async () => {
    const accountId = await createAccount({ deletionScheduledAtDaysAgo: 31 });
    const seedId = await createPersonalSeed(accountId, 60);
    await createSeedPhoto(seedId, `seed-photos/${seedId}/a.jpg`);
    const gardenId = await createGarden(accountId);
    const harvestId = await createHarvestEntry(gardenId, ['harvest-photos/1/x.jpg']);
    await createExportJob(accountId);

    const { affected } = await purgeScheduledAccounts();

    expect(affected).toBe(1);
    expect(await accountIds()).not.toContain(accountId);
    const rows = await queued();
    expect(rows).toEqual(
      expect.arrayContaining([
        { bucket: 'public', path: `seed-photos/${seedId}/`, is_prefix: true },
        { bucket: 'public', path: `garden-thumbnails/${gardenId}/`, is_prefix: true },
        { bucket: 'public', path: `harvest-photos/${harvestId}/`, is_prefix: true },
        { bucket: 'exports', path: `exports/${accountId}/`, is_prefix: true },
      ]),
    );
    expect(rows).toHaveLength(4);
    expect(deleteFromR2Mock).not.toHaveBeenCalled();
  });

  it("deletes the account's sessions and queues their pending guest gardens", async () => {
    const accountId = await createAccount({ deletionScheduledAtDaysAgo: 31 });
    const { rows: sessions } = await pool.query<{ id: string }>(
      `INSERT INTO guest_sessions (token, expires_at, account_id, migrated_at)
       VALUES ('purge-linked', NOW() + INTERVAL '1 day', $1, NOW()) RETURNING id`,
      [accountId],
    );
    const sessionId = sessions[0].id;
    const { rows: gardens } = await pool.query<{ id: number }>(
      `INSERT INTO gardens (guest_session_id, name, style, zone)
       VALUES ($1, 'Pending guest garden', 'grid', '7a') RETURNING id`,
      [sessionId],
    );
    const gardenId = gardens[0].id;
    const harvestId = await createHarvestEntry(gardenId, ['harvest-photos/1/x.jpg']);

    const { affected } = await purgeScheduledAccounts();

    expect(affected).toBe(1);
    expect((await pool.query('SELECT id FROM gardens WHERE id = $1', [gardenId])).rows).toHaveLength(0);
    expect((await pool.query('SELECT id FROM guest_sessions WHERE id = $1', [sessionId])).rows).toHaveLength(0);
    expect(await queued()).toEqual(
      expect.arrayContaining([
        { bucket: 'public', path: `garden-thumbnails/${gardenId}/`, is_prefix: true },
        { bucket: 'public', path: `harvest-photos/${harvestId}/`, is_prefix: true },
      ]),
    );
  });

  it('does not touch the files of an account still within its grace period', async () => {
    const accountId = await createAccount({ deletionScheduledAtDaysAgo: 29 });
    const seedId = await createPersonalSeed(accountId, 60);
    await createSeedPhoto(seedId, 'seed-photos/keep.jpg');
    const gardenId = await createGarden(accountId);
    await createHarvestEntry(gardenId, ['harvest-photos/keep.jpg']);

    const { affected } = await purgeScheduledAccounts();

    expect(affected).toBe(0);
    expect(await queued()).toEqual([]);
    expect(await accountIds()).toContain(accountId);
  });
});

describe('checkSubscriptionDowngrades', () => {
  beforeEach(resetDb);

  it('downgrades expired monthly supporters but leaves lifetime accounts untouched', async () => {
    const monthlyId = await createAccount({
      subscriptionTier: 'supporter',
      stripeSubscriptionId: 'sub_monthly_test',
      subscriptionInterval: 'monthly',
      subscriptionPeriodEndDaysAgo: 1,
    });
    const lifetimeId = await createAccount({
      subscriptionTier: 'supporter',
      stripeSubscriptionId: 'sub_lifetime_test',
      subscriptionInterval: 'lifetime',
      subscriptionPeriodEndDaysAgo: 1,
    });

    await checkSubscriptionDowngrades();

    const { rows } = await pool.query<{
      id: number;
      subscription_tier: string;
      stripe_subscription_id: string | null;
      subscription_interval: string | null;
    }>(
      `SELECT id, subscription_tier, stripe_subscription_id, subscription_interval
       FROM accounts WHERE id = ANY($1::int[])`,
      [[monthlyId, lifetimeId]],
    );
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

    expect(byId[monthlyId].subscription_tier).toBe('free');
    expect(byId[monthlyId].stripe_subscription_id).toBeNull();
    expect(byId[monthlyId].subscription_interval).toBeNull();

    expect(byId[lifetimeId].subscription_tier).toBe('supporter');
    expect(byId[lifetimeId].stripe_subscription_id).toBe('sub_lifetime_test');
    expect(byId[lifetimeId].subscription_interval).toBe('lifetime');
  });
});

describe('purgeExpiredExports', () => {
  beforeEach(async () => {
    await resetDb();
    deleteFromR2Mock.mockReset().mockResolvedValue(undefined);
    exportsBucketMock.mockReset().mockReturnValue('test-exports');
  });

  async function insertJob(
    accountId: number,
    status: string,
    { requestedAgo = '0 seconds', expiresIn = null }: { requestedAgo?: string; expiresIn?: string | null } = {},
  ): Promise<number> {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO data_export_jobs (account_id, status, requested_at, expires_at)
       VALUES ($1, $2, NOW() - $3::interval,
               CASE WHEN $4::text IS NULL THEN NULL ELSE NOW() + $4::interval END)
       RETURNING id`,
      [accountId, status, requestedAgo, expiresIn],
    );
    return rows[0].id;
  }

  async function jobIds(): Promise<number[]> {
    const { rows } = await pool.query<{ id: number }>('SELECT id FROM data_export_jobs ORDER BY id');
    return rows.map((r) => r.id);
  }

  it('deletes an expired complete job and queues its ZIP', async () => {
    const accountId = await createAccount();
    const jobId = await insertJob(accountId, 'complete', { expiresIn: '-1 day' });

    const { affected } = await purgeExpiredExports();

    expect(affected).toBe(1);
    expect(await jobIds()).toEqual([]);
    expect(await queued()).toEqual([
      { bucket: 'exports', path: `exports/${accountId}/${jobId}.zip`, is_prefix: false },
    ]);
    expect(deleteFromR2Mock).not.toHaveBeenCalled();
  });

  it('keeps an unexpired complete job and queues nothing', async () => {
    const accountId = await createAccount();
    const jobId = await insertJob(accountId, 'complete', { expiresIn: '3 days' });

    const { affected } = await purgeExpiredExports();

    expect(affected).toBe(0);
    expect(await jobIds()).toEqual([jobId]);
    expect(await queued()).toEqual([]);
  });

  it('deletes a failed job requested over a day ago and queues its key', async () => {
    const accountId = await createAccount();
    const jobId = await insertJob(accountId, 'failed', { requestedAgo: '2 days' });

    const { affected } = await purgeExpiredExports();

    expect(affected).toBe(1);
    expect(await jobIds()).toEqual([]);
    expect(await queued()).toEqual([
      { bucket: 'exports', path: `exports/${accountId}/${jobId}.zip`, is_prefix: false },
    ]);
  });

  it('keeps a failed job requested an hour ago', async () => {
    const accountId = await createAccount();
    const jobId = await insertJob(accountId, 'failed', { requestedAgo: '1 hour' });

    const { affected } = await purgeExpiredExports();

    expect(affected).toBe(0);
    expect(await jobIds()).toEqual([jobId]);
    expect(await queued()).toEqual([]);
  });

  it('deletes a processing job stuck for over a day and queues its key', async () => {
    const accountId = await createAccount();
    const jobId = await insertJob(accountId, 'processing', { requestedAgo: '2 days' });

    const { affected } = await purgeExpiredExports();

    expect(affected).toBe(1);
    expect(await jobIds()).toEqual([]);
    expect(await queued()).toEqual([
      { bucket: 'exports', path: `exports/${accountId}/${jobId}.zip`, is_prefix: false },
    ]);
  });
});

describe('runNightlyJob', () => {
  beforeEach(async () => {
    await resetDb();
    deleteFromR2Mock.mockReset().mockResolvedValue(undefined);
    exportsBucketMock.mockReset().mockReturnValue('test-exports');
  });

  it('runs to completion and records an ok job_runs row', async () => {
    await runNightlyJob();

    const { rows } = await pool.query<{ status: string; finished_at: Date | null }>(
      `SELECT status, finished_at FROM job_runs WHERE job_key = 'nightly' ORDER BY id DESC LIMIT 1`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('ok');
    expect(rows[0].finished_at).not.toBeNull();
  });

  it('drains what the purges queued in the same run, as the last task', async () => {
    const accountId = await createAccount();
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO data_export_jobs (account_id, status, expires_at)
       VALUES ($1, 'complete', NOW() - INTERVAL '1 day') RETURNING id`,
      [accountId],
    );

    await runNightlyJob();

    expect(deleteFromR2Mock).toHaveBeenCalledWith(
      `exports/${accountId}/${rows[0].id}.zip`,
      'test-exports',
    );
    expect(await queued()).toEqual([]);
  });
});

describe('purgeExpiredGuests — email revert tokens', () => {
  beforeEach(resetDb);

  it('deletes revert tokens created over 30 days ago and keeps newer ones', async () => {
    await pool.query('TRUNCATE email_revert_tokens');
    const accountId = await createAccount();
    await pool.query(
      `INSERT INTO email_revert_tokens (account_id, token_hash, old_email, new_email, expires_at, created_at)
       VALUES ($1, 'old-hash', 'a@example.com', 'b@example.com', NOW() - INTERVAL '24 days', NOW() - INTERVAL '31 days'),
              ($1, 'new-hash', 'a@example.com', 'b@example.com', NOW() + INTERVAL '6 days', NOW() - INTERVAL '1 day')`,
      [accountId],
    );

    await purgeExpiredGuests();

    const { rows } = await pool.query<{ token_hash: string }>('SELECT token_hash FROM email_revert_tokens');
    expect(rows.map((r) => r.token_hash)).toEqual(['new-hash']);
  });
});

describe('purgeStripeEvents', () => {
  it('deletes event ids processed over 90 days ago', async () => {
    await pool.query('TRUNCATE stripe_events');
    await pool.query(
      `INSERT INTO stripe_events (event_id, processed_at)
       VALUES ('evt_old', NOW() - INTERVAL '91 days'), ('evt_new', NOW() - INTERVAL '1 day')`,
    );

    const { affected } = await purgeStripeEvents();

    expect(affected).toBe(1);
    const { rows } = await pool.query<{ event_id: string }>('SELECT event_id FROM stripe_events');
    expect(rows.map((r) => r.event_id)).toEqual(['evt_new']);
  });
});

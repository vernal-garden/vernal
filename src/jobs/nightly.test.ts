import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { Pool } from 'pg';

vi.mock('../lib/r2', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/r2')>()),
  uploadToR2: vi.fn(),
  getPresignedDownloadUrl: vi.fn(),
  deleteFromR2: vi.fn(),
  exportsBucket: vi.fn(() => 'test-exports'),
}));

import { deleteFromR2, exportsBucket } from '../lib/r2';
import { currentSeason } from '../lib/season';
import {
  deriveGrowth,
  refreshGardenBadges,
  purgeExpiredGuests,
  purgeReadNotifications,
  purgeScheduledAccounts,
  checkSubscriptionDowngrades,
  purgeExpiredExports,
  runNightlyJob,
} from './nightly';

const deleteFromR2Mock = vi.mocked(deleteFromR2);
const exportsBucketMock = vi.mocked(exportsBucket);

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL must be set to run tests');

const pool = new Pool({ connectionString: url });

const CURRENT_YEAR = currentSeason();

async function resetDb() {
  await pool.query(
    'TRUNCATE accounts, guest_sessions, gardens, beds, plantings, seeds, password_reset_tokens, job_runs RESTART IDENTITY CASCADE',
  );
  await pool.query('TRUNCATE cambium.seeds, cambium.companions RESTART IDENTITY CASCADE');
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
             0, 0)
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
    opts: { migratedToAccountId?: number } = {},
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
    await pool.query(`UPDATE gardens SET thumbnail_url = $1 WHERE id = $2`, [
      `${BASE}/garden-thumbnails/${gardenId}/x.png`,
      gardenId,
    ]);
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

  it('deletes the thumbnail of an expired guest before the session', async () => {
    const { sessionId, gardenId } = await createGuestWithThumbnail('nightly-guest-thumb');

    const { affected } = await purgeExpiredGuests();

    expect(affected).toBe(1);
    expect(deleteFromR2Mock).toHaveBeenCalledTimes(1);
    expect(deleteFromR2Mock).toHaveBeenCalledWith(`garden-thumbnails/${gardenId}/x.png`);
    expect(await sessionIds()).not.toContain(sessionId);
    expect(await gardenIds()).not.toContain(gardenId);
  });

  it('keeps an expired guest whose thumbnail delete fails', async () => {
    const { sessionId, gardenId } = await createGuestWithThumbnail('nightly-guest-fail');
    deleteFromR2Mock.mockRejectedValueOnce(new Error('R2 down'));

    const { affected } = await purgeExpiredGuests();

    expect(affected).toBe(0);
    expect(await sessionIds()).toContain(sessionId);
    expect(await gardenIds()).toContain(gardenId);
  });

  it('does not touch a migrated guest session or its thumbnail', async () => {
    const ownerId = await createAccount();
    const { sessionId, gardenId } = await createGuestWithThumbnail('nightly-guest-migrated', {
      migratedToAccountId: ownerId,
    });

    await purgeExpiredGuests();

    expect(deleteFromR2Mock).not.toHaveBeenCalled();
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
    savedBaseUrl = process.env.R2_PUBLIC_BASE_URL;
    process.env.R2_PUBLIC_BASE_URL = BASE;
  });

  afterEach(() => {
    if (savedBaseUrl === undefined) delete process.env.R2_PUBLIC_BASE_URL;
    else process.env.R2_PUBLIC_BASE_URL = savedBaseUrl;
  });

  async function createSeedPhoto(seedId: number, key: string): Promise<void> {
    await pool.query(
      `INSERT INTO seed_photos (seed_id, storage_url, r2_key) VALUES ($1, $2, $3)`,
      [seedId, `${BASE}/${key}`, key],
    );
  }

  async function createHarvestEntry(gardenId: number, keys: string[]): Promise<void> {
    const photos = keys.map((key) => ({ key, url: `${BASE}/${key}` }));
    await pool.query(`INSERT INTO harvest_entries (garden_id, photos) VALUES ($1, $2::jsonb)`, [
      gardenId,
      JSON.stringify(photos),
    ]);
  }

  async function setThumbnail(gardenId: number, url: string): Promise<void> {
    await pool.query(`UPDATE gardens SET thumbnail_url = $1 WHERE id = $2`, [url, gardenId]);
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

  it('deletes seed photos, owned thumbnails and complete exports before the account', async () => {
    const accountId = await createAccount({ deletionScheduledAtDaysAgo: 31 });
    const seedId = await createPersonalSeed(accountId, 60);
    await createSeedPhoto(seedId, 'seed-photos/a.jpg');
    await createSeedPhoto(seedId, 'seed-photos/b.jpg');
    const gardenId = await createGarden(accountId);
    await setThumbnail(gardenId, `${BASE}/garden-thumbnails/${gardenId}/x.png`);
    const jobId = await createExportJob(accountId);
    await createExportJob(accountId, 'failed');

    const { affected } = await purgeScheduledAccounts();

    expect(affected).toBe(1);
    expect(deleteFromR2Mock).toHaveBeenCalledTimes(4);
    expect(deleteFromR2Mock).toHaveBeenCalledWith('seed-photos/a.jpg', undefined);
    expect(deleteFromR2Mock).toHaveBeenCalledWith('seed-photos/b.jpg', undefined);
    expect(deleteFromR2Mock).toHaveBeenCalledWith(
      `garden-thumbnails/${gardenId}/x.png`,
      undefined,
    );
    expect(deleteFromR2Mock).toHaveBeenCalledWith(
      `exports/${accountId}/${jobId}.zip`,
      'test-exports',
    );
    expect(await accountIds()).not.toContain(accountId);
  });

  it('deletes every harvest photo in the account gardens', async () => {
    const accountId = await createAccount({ deletionScheduledAtDaysAgo: 31 });
    const gardenId = await createGarden(accountId);
    await createHarvestEntry(gardenId, ['harvest-photos/1.jpg', 'harvest-photos/2.jpg']);

    const { affected } = await purgeScheduledAccounts();

    expect(affected).toBe(1);
    expect(deleteFromR2Mock).toHaveBeenCalledTimes(2);
    expect(deleteFromR2Mock).toHaveBeenCalledWith('harvest-photos/1.jpg', undefined);
    expect(deleteFromR2Mock).toHaveBeenCalledWith('harvest-photos/2.jpg', undefined);
    expect(exportsBucketMock).not.toHaveBeenCalled();
    expect(await accountIds()).not.toContain(accountId);
  });

  it('does not delete a thumbnail outside the garden own prefix', async () => {
    const accountId = await createAccount({ deletionScheduledAtDaysAgo: 31 });
    const gardenId = await createGarden(accountId);
    await setThumbnail(gardenId, `${BASE}/garden-thumbnails/${gardenId + 1000}/x.png`);

    const { affected } = await purgeScheduledAccounts();

    expect(affected).toBe(1);
    expect(deleteFromR2Mock).not.toHaveBeenCalled();
    expect(await accountIds()).not.toContain(accountId);
  });

  it('keeps an account whose object delete fails and still purges others', async () => {
    const failingId = await createAccount({ deletionScheduledAtDaysAgo: 31 });
    const seedId = await createPersonalSeed(failingId, 60);
    await createSeedPhoto(seedId, 'seed-photos/ok.jpg');
    await createSeedPhoto(seedId, 'seed-photos/boom.jpg');
    const emptyId = await createAccount({ deletionScheduledAtDaysAgo: 31 });
    deleteFromR2Mock.mockImplementation(async (key: string) => {
      if (key === 'seed-photos/boom.jpg') throw new Error('R2 unavailable');
    });

    const { affected } = await purgeScheduledAccounts();

    expect(affected).toBe(1);
    const ids = await accountIds();
    expect(ids).toContain(failingId);
    expect(ids).not.toContain(emptyId);
    const { rows } = await pool.query<{ r2_key: string }>(
      'SELECT r2_key FROM seed_photos ORDER BY r2_key',
    );
    expect(rows.map((r) => r.r2_key)).toEqual(['seed-photos/boom.jpg', 'seed-photos/ok.jpg']);
  });

  it('does not touch the files of an account still within its grace period', async () => {
    const accountId = await createAccount({ deletionScheduledAtDaysAgo: 29 });
    const seedId = await createPersonalSeed(accountId, 60);
    await createSeedPhoto(seedId, 'seed-photos/keep.jpg');
    const gardenId = await createGarden(accountId);
    await createHarvestEntry(gardenId, ['harvest-photos/keep.jpg']);

    const { affected } = await purgeScheduledAccounts();

    expect(affected).toBe(0);
    expect(deleteFromR2Mock).not.toHaveBeenCalled();
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

  it('deletes expired export ZIPs from R2 and removes their rows, keeping unexpired ones', async () => {
    const accountId = await createAccount();
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO data_export_jobs (account_id, status, download_url, expires_at)
       VALUES ($1, 'complete', 'https://signed.example.com/old', NOW() - INTERVAL '1 day'),
              ($1, 'complete', 'https://signed.example.com/new', NOW() + INTERVAL '3 days')
       RETURNING id`,
      [accountId],
    );
    const [expiredId, freshId] = rows.map((r) => r.id);

    const { affected } = await purgeExpiredExports();

    expect(affected).toBe(1);
    expect(deleteFromR2Mock).toHaveBeenCalledTimes(1);
    expect(deleteFromR2Mock).toHaveBeenCalledWith(
      `exports/${accountId}/${expiredId}.zip`,
      'test-exports',
    );
    const { rows: remaining } = await pool.query<{ id: number }>(
      'SELECT id FROM data_export_jobs ORDER BY id',
    );
    expect(remaining.map((r) => r.id)).toEqual([freshId]);
  });

  it('rejects and keeps the expired row when the exports bucket is not configured', async () => {
    exportsBucketMock.mockImplementation(() => {
      throw new Error('R2_EXPORTS_BUCKET_NAME is not set.');
    });
    const accountId = await createAccount();
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO data_export_jobs (account_id, status, download_url, expires_at)
       VALUES ($1, 'complete', 'https://signed.example.com/old', NOW() - INTERVAL '1 day')
       RETURNING id`,
      [accountId],
    );

    await expect(purgeExpiredExports()).rejects.toThrow('R2_EXPORTS_BUCKET_NAME is not set.');

    expect(deleteFromR2Mock).not.toHaveBeenCalled();
    const { rows: remaining } = await pool.query<{ id: number }>(
      'SELECT id FROM data_export_jobs ORDER BY id',
    );
    expect(remaining.map((r) => r.id)).toEqual([rows[0].id]);
  });
});

describe('runNightlyJob', () => {
  beforeEach(resetDb);

  it('runs to completion and records an ok job_runs row', async () => {
    await runNightlyJob();

    const { rows } = await pool.query<{ status: string; finished_at: Date | null }>(
      `SELECT status, finished_at FROM job_runs WHERE job_key = 'nightly' ORDER BY id DESC LIMIT 1`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('ok');
    expect(rows[0].finished_at).not.toBeNull();
  });
});

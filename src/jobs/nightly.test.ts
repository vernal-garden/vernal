import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import {
  deriveGrowth,
  refreshGardenBadges,
  purgeExpiredGuests,
  purgeScheduledAccounts,
  checkSubscriptionDowngrades,
  runNightlyJob,
} from './nightly';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL must be set to run tests');

const pool = new Pool({ connectionString: url });

const CURRENT_YEAR = new Date().getFullYear();

async function resetDb() {
  await pool.query(
    'TRUNCATE accounts, guest_sessions, gardens, beds, plantings, seeds, password_reset_tokens, job_runs RESTART IDENTITY CASCADE',
  );
  await pool.query('TRUNCATE cambium.seeds, cambium.companion_pairs RESTART IDENTITY CASCADE');
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

async function createPersonalSeed(ownerId: number, maturityDaysMax: number | null): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO seeds (owner_id, common_name, origin, contribution_status, maturity_days_max)
     VALUES ($1, 'Nightly Test Plant', 'user_created', 'private', $2)
     RETURNING id`,
    [ownerId, maturityDaysMax],
  );
  return rows[0].id;
}

async function createPlanting(
  bedId: number,
  gardenId: number,
  overrides: {
    seedId?: number | null;
    cambiumSeedId?: number | null;
    plantingDateDaysAgo?: number | null;
    indicatorDismissed?: boolean;
  } = {},
): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO plantings
       (bed_id, garden_id, season, seed_id, cambium_seed_id, planting_date, indicator_dismissed_at, cell_x, cell_y)
     VALUES ($1, $2, $3, $4, $5,
             CASE WHEN $6::int IS NULL THEN NULL ELSE CURRENT_DATE - $6::int END,
             CASE WHEN $7::bool THEN NOW() ELSE NULL END,
             0, 0)
     RETURNING id`,
    [
      bedId,
      gardenId,
      CURRENT_YEAR,
      overrides.seedId ?? null,
      overrides.cambiumSeedId ?? null,
      overrides.plantingDateDaysAgo ?? null,
      overrides.indicatorDismissed ?? false,
    ],
  );
  return rows[0].id;
}

afterAll(() => pool.end());

describe('deriveGrowth', () => {
  beforeEach(resetDb);

  it('marks a planting at 100% maturity harvest-ready with growth_stage 5', async () => {
    const ownerId = await createAccount();
    const gardenId = await createGarden(ownerId);
    const bedId = await createBed(gardenId);
    const seedId = await createPersonalSeed(ownerId, 60);
    const plantingId = await createPlanting(bedId, gardenId, { seedId, plantingDateDaysAgo: 60 });

    await deriveGrowth();

    const { rows } = await pool.query(
      `SELECT growth_stage_pct, growth_stage, displayed_growth_stage, harvest_ready,
              harvest_window_end, planting_date
       FROM plantings WHERE id = $1`,
      [plantingId],
    );
    const row = rows[0];
    expect(Number(row.growth_stage_pct)).toBe(100);
    expect(row.growth_stage).toBe(5);
    expect(row.displayed_growth_stage).toBe(5);
    expect(row.harvest_ready).toBe(true);

    const expectedWindowEnd = new Date(row.planting_date);
    expectedWindowEnd.setUTCDate(expectedWindowEnd.getUTCDate() + 60 + 14);
    expect(new Date(row.harvest_window_end).toISOString().slice(0, 10)).toBe(
      expectedWindowEnd.toISOString().slice(0, 10),
    );
  });

  it('marks a planting at 50% maturity as growth_stage 3 and not harvest-ready', async () => {
    const ownerId = await createAccount();
    const gardenId = await createGarden(ownerId);
    const bedId = await createBed(gardenId);
    const seedId = await createPersonalSeed(ownerId, 60);
    const plantingId = await createPlanting(bedId, gardenId, { seedId, plantingDateDaysAgo: 30 });

    await deriveGrowth();

    const { rows } = await pool.query(
      `SELECT growth_stage_pct, growth_stage, harvest_ready FROM plantings WHERE id = $1`,
      [plantingId],
    );
    const row = rows[0];
    expect(Number(row.growth_stage_pct)).toBe(50);
    expect(row.growth_stage).toBe(3);
    expect(row.harvest_ready).toBe(false);
  });

  it('leaves growth fields unchanged when planting_date is null', async () => {
    const ownerId = await createAccount();
    const gardenId = await createGarden(ownerId);
    const bedId = await createBed(gardenId);
    const seedId = await createPersonalSeed(ownerId, 60);
    const plantingId = await createPlanting(bedId, gardenId, { seedId, plantingDateDaysAgo: null });

    await deriveGrowth();

    const { rows } = await pool.query(
      `SELECT growth_stage_pct, growth_stage, displayed_growth_stage, harvest_ready, harvest_window_end
       FROM plantings WHERE id = $1`,
      [plantingId],
    );
    const row = rows[0];
    expect(row.growth_stage_pct).toBeNull();
    expect(row.growth_stage).toBeNull();
    expect(row.displayed_growth_stage).toBeNull();
    expect(row.harvest_ready).toBe(false);
    expect(row.harvest_window_end).toBeNull();
  });

  it('leaves growth fields unchanged when the seed has no maturity_days_max', async () => {
    const ownerId = await createAccount();
    const gardenId = await createGarden(ownerId);
    const bedId = await createBed(gardenId);
    const seedId = await createPersonalSeed(ownerId, null);
    const plantingId = await createPlanting(bedId, gardenId, { seedId, plantingDateDaysAgo: 10 });

    await deriveGrowth();

    const { rows } = await pool.query(
      `SELECT growth_stage_pct, growth_stage, displayed_growth_stage, harvest_ready, harvest_window_end
       FROM plantings WHERE id = $1`,
      [plantingId],
    );
    const row = rows[0];
    expect(row.growth_stage_pct).toBeNull();
    expect(row.growth_stage).toBeNull();
    expect(row.displayed_growth_stage).toBeNull();
    expect(row.harvest_ready).toBe(false);
    expect(row.harvest_window_end).toBeNull();
  });

  it('keeps harvest_ready false at 100% maturity when indicator_dismissed_at is set', async () => {
    const ownerId = await createAccount();
    const gardenId = await createGarden(ownerId);
    const bedId = await createBed(gardenId);
    const seedId = await createPersonalSeed(ownerId, 60);
    const plantingId = await createPlanting(bedId, gardenId, {
      seedId,
      plantingDateDaysAgo: 60,
      indicatorDismissed: true,
    });

    await deriveGrowth();

    const { rows } = await pool.query(
      `SELECT growth_stage, harvest_ready FROM plantings WHERE id = $1`,
      [plantingId],
    );
    const row = rows[0];
    expect(row.growth_stage).toBe(5);
    expect(row.harvest_ready).toBe(false);
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

  it('flags has_companion_warnings only for gardens with a harmful companion pair', async () => {
    const ownerId = await createAccount();
    const seedA = await createCambiumSeed();
    const seedB = await createCambiumSeed();
    const otherSeed = await createCambiumSeed();
    const [idA, idB] = [seedA, seedB].sort((a, b) => a - b);
    await pool.query(
      `INSERT INTO cambium.companion_pairs (seed_id_a, seed_id_b, relationship)
       VALUES ($1, $2, 'harmful')`,
      [idA, idB],
    );

    const gardenWarn = await createGarden(ownerId);
    const bedWarn = await createBed(gardenWarn);
    await createPlanting(bedWarn, gardenWarn, { cambiumSeedId: seedA });
    await createPlanting(bedWarn, gardenWarn, { cambiumSeedId: seedB });

    const gardenClean = await createGarden(ownerId);
    const bedClean = await createBed(gardenClean);
    await createPlanting(bedClean, gardenClean, { cambiumSeedId: seedA });
    await createPlanting(bedClean, gardenClean, { cambiumSeedId: otherSeed });

    await refreshGardenBadges();

    const { rows } = await pool.query<{ id: number; has_companion_warnings: boolean }>(
      `SELECT id, has_companion_warnings FROM gardens WHERE id = ANY($1::int[])`,
      [[gardenWarn, gardenClean]],
    );
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.has_companion_warnings]));
    expect(byId[gardenWarn]).toBe(true);
    expect(byId[gardenClean]).toBe(false);
  });
});

describe('purgeExpiredGuests', () => {
  beforeEach(resetDb);

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

describe('purgeScheduledAccounts', () => {
  beforeEach(resetDb);

  it('deletes accounts 31 days past their scheduled deletion but keeps ones 29 days past', async () => {
    const idPastGrace = await createAccount({ deletionScheduledAtDaysAgo: 31 });
    const idWithinGrace = await createAccount({ deletionScheduledAtDaysAgo: 29 });

    await purgeScheduledAccounts();

    const { rows } = await pool.query<{ id: number }>('SELECT id FROM accounts');
    const ids = rows.map((r) => r.id);
    expect(ids).not.toContain(idPastGrace);
    expect(ids).toContain(idWithinGrace);
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

import { db } from '../lib/db';

// The only writer of plantings.growth_stage_pct, growth_stage,
// displayed_growth_stage, harvest_ready, and harvest_window_end — routes
// must never write these fields directly.
export async function deriveGrowth(): Promise<{ affected: number }> {
  const result = await db.query(`
    WITH seed_maturity AS (
      SELECT p.id AS planting_id,
        COALESCE(ps.maturity_days_max, cs.maturity_days_max) AS maturity
      FROM plantings p
      LEFT JOIN seeds ps ON ps.id = p.seed_id
      LEFT JOIN cambium.seeds cs ON cs.id = p.cambium_seed_id
      WHERE p.planting_date IS NOT NULL
        AND COALESCE(ps.maturity_days_max, cs.maturity_days_max) IS NOT NULL
    ),
    calc AS (
      SELECT sm.planting_id,
        sm.maturity,
        LEAST(100.0, GREATEST(0.0,
          (CURRENT_DATE - p.planting_date)::NUMERIC / sm.maturity * 100
        )) AS pct
      FROM seed_maturity sm
      JOIN plantings p ON p.id = sm.planting_id
    )
    UPDATE plantings p SET
      growth_stage_pct       = c.pct,
      growth_stage           = GREATEST(1, LEAST(5, CEIL(c.pct / 20.0)::int)),
      displayed_growth_stage = GREATEST(1, LEAST(5, CEIL(c.pct / 20.0)::int)),
      harvest_ready          = c.pct >= 100.0 AND p.indicator_dismissed_at IS NULL,
      harvest_window_end     = p.planting_date + c.maturity + 14,
      updated_at             = NOW()
    FROM calc c
    WHERE p.id = c.planting_id
  `);
  return { affected: result.rowCount ?? 0 };
}

// Must run after deriveGrowth — reads harvest_ready values it just wrote.
export async function refreshGardenBadges(): Promise<{ affected: number }> {
  const result = await db.query(`
    UPDATE gardens g SET
      harvestable_count = (
        SELECT COUNT(*)::int FROM plantings p
        WHERE p.garden_id = g.id
          AND p.harvest_ready = true
          AND p.indicator_dismissed_at IS NULL
      ),
      has_companion_warnings = EXISTS (
        SELECT 1
        FROM plantings p1
        JOIN plantings p2
          ON p2.garden_id = p1.garden_id
          AND p1.id < p2.id
          AND p2.cambium_seed_id IS NOT NULL
        JOIN cambium.companion_pairs cp
          ON cp.seed_id_a = LEAST(p1.cambium_seed_id, p2.cambium_seed_id)
          AND cp.seed_id_b = GREATEST(p1.cambium_seed_id, p2.cambium_seed_id)
          AND cp.relationship = 'harmful'
        WHERE p1.garden_id = g.id
          AND p1.cambium_seed_id IS NOT NULL
          AND p1.season = EXTRACT(YEAR FROM CURRENT_DATE)::int
          AND p2.season = p1.season
      ),
      updated_at = NOW()
  `);
  return { affected: result.rowCount ?? 0 };
}

export async function purgeExpiredGuests(): Promise<{ affected: number }> {
  const guestsResult = await db.query(
    `DELETE FROM guest_sessions WHERE expires_at < NOW() AND migrated_at IS NULL`,
  );
  const tokensResult = await db.query(
    `DELETE FROM password_reset_tokens WHERE expires_at < NOW()`,
  );
  return { affected: (guestsResult.rowCount ?? 0) + (tokensResult.rowCount ?? 0) };
}

export async function purgeScheduledAccounts(): Promise<{ affected: number }> {
  const result = await db.query(
    `DELETE FROM accounts WHERE deletion_scheduled_at + INTERVAL '30 days' < NOW()`,
  );
  return { affected: result.rowCount ?? 0 };
}

// Lifetime accounts have subscription_interval = 'lifetime', excluded by the
// IN clause below — this task must never touch them.
export async function checkSubscriptionDowngrades(): Promise<{ affected: number }> {
  const result = await db.query(`
    UPDATE accounts SET
      subscription_tier       = 'free',
      stripe_subscription_id  = NULL,
      subscription_interval   = NULL,
      subscription_period_end = NULL,
      updated_at              = NOW()
    WHERE subscription_tier = 'supporter'
      AND subscription_interval IN ('monthly', 'annual')
      AND subscription_period_end < NOW()
  `);
  return { affected: result.rowCount ?? 0 };
}

export async function runNightlyJob(): Promise<void> {
  const started = new Date();
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO job_runs (job_key, status, started_at)
     VALUES ('nightly', 'ok', $1) RETURNING id`,
    [started],
  );
  const runId = rows[0].id;
  const errors: string[] = [];

  const tasks: Array<[string, () => Promise<{ affected: number }>]> = [
    ['deriveGrowth', deriveGrowth],
    ['refreshGardenBadges', refreshGardenBadges],
    ['purgeExpiredGuests', purgeExpiredGuests],
    ['purgeScheduledAccounts', purgeScheduledAccounts],
    ['checkSubscriptionDowngrades', checkSubscriptionDowngrades],
  ];

  for (const [name, task] of tasks) {
    try {
      const { affected } = await task();
      console.log(`[nightly] ${name}: ${affected} rows`);
    } catch (err) {
      console.error(`[nightly] ${name} failed:`, err);
      errors.push(`${name}: ${String(err)}`);
    }
  }

  await db.query(
    `UPDATE job_runs SET status = $1, finished_at = NOW(), error_msg = $2
     WHERE id = $3`,
    [errors.length ? 'failed' : 'ok', errors.length ? errors.join('; ') : null, runId],
  );

  if (errors.length) {
    throw new Error(`Nightly job completed with errors: ${errors.join('; ')}`);
  }
}

import { db } from '../lib/db';
import { COMPANION_CONFIDENCE_THRESHOLD } from '../services/cambium';
import { deleteFromR2, exportsBucket, ownedThumbnailKey } from '../lib/r2';
import { logger } from '../lib/logger';
import { teardownCustomer } from '../lib/billing';
import { exportKey } from '../lib/exportWorker';
import { harvestableCountSql } from '../lib/gardenBadges';
import { STAGE_BOUNDS } from '../lib/growthStages';
import { currentSeason } from '../lib/season';

// The only writer of plantings.growth_stage_pct, growth_stage, harvest_ready,
// and harvest_window_end — routes must never write these fields directly.
// displayed_growth_stage is not written here: the client acknowledges the
// stage it has shown through PATCH /api/gardens/:gardenId/plantings/displayed-stage.
//
// A planting is anchored once a sowing event for the same garden, seed, and
// season is marked done. It grows from its planting_date, or failing that from
// the Pacific date of the earliest done event. Unanchored plantings, and those
// whose seed has no maturity days, get null growth and are never harvest-ready.
// Stage bounds come from STAGE_BOUNDS so SQL and stageFor() can't drift; pct is
// rounded to the column's two decimals before the stage is chosen.
export async function deriveGrowth(): Promise<{ affected: number }> {
  const result = await db.query(
    `
    WITH anchor AS (
      -- maturity stays NULL for unanchored plantings, which nulls everything below.
      SELECT p.id AS planting_id,
        p.indicator_dismissed_at,
        p.season,
        COALESCE(p.planting_date,
          (ds.first_done_at AT TIME ZONE 'America/Los_Angeles')::date) AS sow_date,
        CASE WHEN ds.first_done_at IS NOT NULL THEN
          NULLIF(COALESCE(ps.maturity_days_min, ps.maturity_days_max,
            cs.maturity_days_min, cs.maturity_days_max), 0)
        END AS maturity,
        COALESCE(ps.maturity_days_max, ps.maturity_days_min,
          cs.maturity_days_max, cs.maturity_days_min) AS window_days
      FROM plantings p
      -- Seed key as in routes/harvests.ts seedKeyWhere: seed_id when the
      -- planting has one, else a Cambium-only event.
      LEFT JOIN LATERAL (
        SELECT MIN(se.marked_done_at) AS first_done_at
        FROM sowing_events se
        WHERE se.garden_id = p.garden_id
          AND se.season = p.season
          AND se.marked_done_at IS NOT NULL
          AND CASE WHEN p.seed_id IS NOT NULL THEN se.seed_id = p.seed_id
                   ELSE se.seed_id IS NULL AND se.cambium_seed_id = p.cambium_seed_id END
      ) ds ON true
      LEFT JOIN seeds ps ON ps.id = p.seed_id
      LEFT JOIN cambium.seeds cs ON cs.id = p.cambium_seed_id
    ),
    calc AS (
      SELECT a.*,
        -- GREATEST/LEAST skip NULLs, so guard unanchored / no-maturity rows.
        CASE WHEN a.maturity IS NOT NULL THEN
          ROUND(LEAST(100.0, GREATEST(0.0,
            ((NOW() AT TIME ZONE 'America/Los_Angeles')::date - a.sow_date)::NUMERIC
              / a.maturity * 100
          )), 2)
        END AS pct
      FROM anchor a
    ),
    derived AS (
      SELECT c.planting_id,
        c.pct,
        CASE
          WHEN c.pct IS NULL THEN NULL
          WHEN c.pct >= $3::numeric THEN 5
          WHEN c.pct >  $2::numeric THEN 4
          WHEN c.pct >  $1::numeric THEN 3
          WHEN c.pct >  0 THEN 2
          ELSE 1
        END::smallint AS stage,
        COALESCE(c.pct >= $3::numeric, false)
          AND c.indicator_dismissed_at IS NULL
          AND c.season = $4::int AS ready,
        CASE WHEN c.pct IS NOT NULL THEN c.sow_date + c.window_days + 14 END AS window_end
      FROM calc c
    )
    UPDATE plantings p SET
      growth_stage_pct   = d.pct,
      growth_stage       = d.stage,
      harvest_ready      = d.ready,
      harvest_window_end = d.window_end,
      updated_at         = NOW()
    FROM derived d
    WHERE p.id = d.planting_id
      -- Only rows whose derived values change, so updated_at and rowCount
      -- reflect real changes.
      AND (p.growth_stage_pct, p.growth_stage, p.harvest_ready, p.harvest_window_end)
        IS DISTINCT FROM (d.pct, d.stage, d.ready, d.window_end)
  `,
    [STAGE_BOUNDS.seedling, STAGE_BOUNDS.vegetative, STAGE_BOUNDS.ready, currentSeason()],
  );
  return { affected: result.rowCount ?? 0 };
}

// Must run after deriveGrowth — reads harvest_ready values it just wrote.
export async function refreshGardenBadges(): Promise<{ affected: number }> {
  const result = await db.query(`
    UPDATE gardens g SET
      harvestable_count = ${harvestableCountSql('g.id')},
      has_companion_warnings = EXISTS (
        SELECT 1
        FROM plantings p1
        JOIN plantings p2
          ON p2.garden_id = p1.garden_id
          AND p1.id < p2.id
          AND p2.cambium_seed_id IS NOT NULL
        JOIN cambium.companions c
          ON (
            (c.seed_id = p1.cambium_seed_id AND c.companion_seed_id = p2.cambium_seed_id)
            OR
            (c.seed_id = p2.cambium_seed_id AND c.companion_seed_id = p1.cambium_seed_id)
          )
          AND c.relationship = 'antagonistic'
          AND c.confidence >= $1
        WHERE p1.garden_id = g.id
          AND p1.cambium_seed_id IS NOT NULL
          AND p1.season = $2::int
          AND p2.season = p1.season
      ),
      updated_at = NOW()
  `, [COMPANION_CONFIDENCE_THRESHOLD, currentSeason()]);
  return { affected: result.rowCount ?? 0 };
}

// Deletes expired, unmigrated guest sessions after deleting the garden
// thumbnails they saved to R2 (guests can't upload anything else). If a
// thumbnail delete fails the session row is kept: its cascade would delete the
// gardens that record the keys, so tomorrow's run could never find them again.
// Also deletes expired password reset tokens.
export async function purgeExpiredGuests(): Promise<{ affected: number }> {
  const { rows: sessions } = await db.query<{ id: string }>(
    `SELECT id FROM guest_sessions WHERE expires_at < NOW() AND migrated_at IS NULL`,
  );

  let guestsAffected = 0;
  if (sessions.length > 0) {
    const sessionIds = sessions.map((s) => s.id);
    const { rows: gardens } = await db.query<{
      id: number;
      guest_session_id: string;
      thumbnail_url: string | null;
    }>(
      `SELECT id, guest_session_id, thumbnail_url FROM gardens
       WHERE guest_session_id = ANY($1::uuid[]) AND thumbnail_url IS NOT NULL`,
      [sessionIds],
    );
    const keysBySession = new Map<string, string[]>();
    for (const garden of gardens) {
      const key = ownedThumbnailKey(garden.thumbnail_url, String(garden.id));
      if (!key) continue;
      const keys = keysBySession.get(garden.guest_session_id) ?? [];
      keys.push(key);
      keysBySession.set(garden.guest_session_id, keys);
    }

    const purgeable: string[] = [];
    for (const id of sessionIds) {
      let key: string | undefined;
      try {
        for (const k of keysBySession.get(id) ?? []) {
          key = k;
          await deleteFromR2(k);
        }
        purgeable.push(id);
      } catch (err) {
        logger.warn('Could not delete R2 object for expired guest; keeping session', {
          sessionId: id,
          key,
          errMsg: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (purgeable.length > 0) {
      const result = await db.query('DELETE FROM guest_sessions WHERE id = ANY($1::uuid[])', [
        purgeable,
      ]);
      guestsAffected = result.rowCount ?? 0;
    }
  }

  const tokensResult = await db.query(
    `DELETE FROM password_reset_tokens WHERE expires_at < NOW()`,
  );
  const verificationResult = await db.query(
    `DELETE FROM email_verification_tokens WHERE expires_at < NOW()`,
  );
  return {
    affected: guestsAffected + (tokensResult.rowCount ?? 0) + (verificationResult.rowCount ?? 0),
  };
}

// Read notifications are kept 90 days; unread ones are never purged.
export async function purgeReadNotifications(): Promise<{ affected: number }> {
  const result = await db.query(
    `DELETE FROM notifications WHERE read_at IS NOT NULL AND read_at < NOW() - INTERVAL '90 days'`,
  );
  return { affected: result.rowCount ?? 0 };
}

// Every R2 object an account owns: seed photos, harvest photos and garden
// thumbnails in the default bucket, and complete export ZIPs in the exports
// bucket. exportsBucket() is only called when the account has such an export.
async function accountStorageKeys(
  accountId: number,
): Promise<Array<{ key: string; bucket?: string }>> {
  const { rows: photos } = await db.query<{ key: string }>(
    `SELECT sp.r2_key AS key
     FROM seed_photos sp
     JOIN seeds s ON s.id = sp.seed_id
     WHERE s.owner_id = $1
     UNION ALL
     SELECT jsonb_array_elements(h.photos) ->> 'key' AS key
     FROM harvest_entries h
     JOIN gardens g ON g.id = h.garden_id
     WHERE g.owner_id = $1`,
    [accountId],
  );
  const { rows: gardens } = await db.query<{ id: number; thumbnail_url: string | null }>(
    `SELECT id, thumbnail_url FROM gardens WHERE owner_id = $1 AND thumbnail_url IS NOT NULL`,
    [accountId],
  );
  const { rows: exports } = await db.query<{ id: number }>(
    `SELECT id FROM data_export_jobs WHERE account_id = $1 AND status = 'complete'`,
    [accountId],
  );

  const keys: Array<{ key: string; bucket?: string }> = [];
  for (const { key } of photos) {
    if (key) keys.push({ key });
  }
  for (const garden of gardens) {
    const key = ownedThumbnailKey(garden.thumbnail_url, String(garden.id));
    if (key) keys.push({ key });
  }
  if (exports.length > 0) {
    const bucket = exportsBucket();
    for (const job of exports) keys.push({ key: exportKey(accountId, job.id), bucket });
  }
  return keys;
}

// Deletes accounts 30 days past their scheduled deletion, after ending their
// Stripe customer and deleting every R2 object they own. If any of that fails
// (or the exports bucket is misconfigured) the account row is kept: its
// cascade would delete the rows that record the keys/ids, so tomorrow's run
// could never find them again.
export async function purgeScheduledAccounts(): Promise<{ affected: number }> {
  const { rows } = await db.query<{
    id: number;
    stripe_subscription_id: string | null;
    stripe_customer_id: string | null;
  }>(
    `SELECT id, stripe_subscription_id, stripe_customer_id
       FROM accounts WHERE deletion_scheduled_at + INTERVAL '30 days' < NOW()`,
  );

  const purgeable: number[] = [];
  for (const { id, stripe_subscription_id, stripe_customer_id } of rows) {
    let key: string | undefined;
    try {
      await teardownCustomer({ subId: stripe_subscription_id, customerId: stripe_customer_id });
      for (const object of await accountStorageKeys(id)) {
        key = object.key;
        await deleteFromR2(object.key, object.bucket);
      }
      purgeable.push(id);
    } catch (err) {
      logger.warn('Could not clean up external data for purged account; keeping account', {
        accountId: id,
        key,
        errMsg: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (purgeable.length === 0) return { affected: 0 };

  const result = await db.query('DELETE FROM accounts WHERE id = ANY($1::int[])', [purgeable]);
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

// Deletes expired export ZIPs from the private exports bucket, then their job
// rows. A failed object delete is logged and does not keep the row. If the
// exports bucket is misconfigured this throws before any row is deleted.
export async function purgeExpiredExports(): Promise<{ affected: number }> {
  const { rows } = await db.query<{ id: number; account_id: number }>(
    `SELECT id, account_id FROM data_export_jobs
     WHERE status = 'complete' AND expires_at < NOW()`,
  );
  if (rows.length === 0) return { affected: 0 };

  const bucket = exportsBucket();
  for (const row of rows) {
    const key = exportKey(row.account_id, row.id);
    try {
      await deleteFromR2(key, bucket);
    } catch (err) {
      logger.warn('Could not delete expired export from R2', {
        jobId: row.id,
        key,
        errMsg: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const result = await db.query('DELETE FROM data_export_jobs WHERE id = ANY($1::int[])', [
    rows.map((r) => r.id),
  ]);
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
    ['purgeReadNotifications', purgeReadNotifications],
    ['purgeScheduledAccounts', purgeScheduledAccounts],
    ['checkSubscriptionDowngrades', checkSubscriptionDowngrades],
    ['purgeExpiredExports', purgeExpiredExports],
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

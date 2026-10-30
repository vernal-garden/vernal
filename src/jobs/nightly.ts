import { jobDb as db, db as webDb } from '../lib/db'; // long-running work: job pool, 5-min statement cap
import { COMPANION_CONFIDENCE_THRESHOLD, deleteAccountRatings } from '../services/cambium';
import { gardenThumbnailFolder, seedPhotoFolder, exportFolder } from '../lib/storage/keys';
import { queueR2Deletions, gardenFiles, drainR2Deletions, type R2Deletion } from '../lib/r2Cleanup';
import { logger } from '../lib/logger';
import { teardownCustomer } from '../lib/billing';
import { getServerConfig } from '../lib/serverConfig';
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

const GUEST_PURGE_BATCH = 5000;

// Purges one batch of expired, unmigrated guest sessions and queues the
// thumbnail folders of their gardens (guests can't upload anything else, and
// thumbnails are uploaded by the server, so gardens without one own nothing).
async function purgeExpiredGuestBatch(sessionIds: string[]): Promise<number> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: gardens } = await client.query<{ id: number }>(
      `SELECT id FROM gardens
        WHERE guest_session_id = ANY($1::uuid[]) AND thumbnail_url IS NOT NULL`,
      [sessionIds],
    );
    await queueR2Deletions(
      client,
      gardens.map((g) => ({ bucket: 'public', path: gardenThumbnailFolder(g.id), isPrefix: true })),
    );
    const result = await client.query('DELETE FROM guest_sessions WHERE id = ANY($1::uuid[])', [sessionIds]);
    await client.query('COMMIT');
    return result.rowCount ?? 0;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Deletes expired, unmigrated guest sessions (queueing their R2 thumbnails), then
// guest sessions over 2 days old that never created anything — those are
// mostly bots and bounced visitors, and own nothing in R2 — then account
// sessions over 30 days past expiry that own no guest data. All passes work in
// batches so a flood of junk rows can't exhaust memory. Also deletes expired
// password reset and email verification tokens, and email-change and
// email-revert tokens over 30 days old.
export async function purgeExpiredGuests(
  { batchSize = GUEST_PURGE_BATCH }: { batchSize?: number } = {},
): Promise<{ affected: number }> {
  let guestsAffected = 0;

  // Keyset pagination by id.
  let afterId: string | null = null;
  for (;;) {
    // Annotated: afterId is reassigned from rows, which defeats inference.
    const { rows }: { rows: Array<{ id: string }> } = await db.query<{ id: string }>(
      `SELECT id FROM guest_sessions
        WHERE expires_at < NOW() AND migrated_at IS NULL
          AND ($1::uuid IS NULL OR id > $1::uuid)
        ORDER BY id
        LIMIT $2`,
      [afterId, batchSize],
    );
    if (rows.length === 0) break;
    afterId = rows[rows.length - 1].id;
    guestsAffected += await purgeExpiredGuestBatch(rows.map((r) => r.id));
    if (rows.length < batchSize) break;
  }

  // Empty guests: lock candidates first, then delete with the emptiness check
  // re-run. The second statement gets a fresh snapshot (READ COMMITTED), so a
  // garden committed after the candidate scan keeps its session. SKIP LOCKED
  // skips a guest whose POST /api/gardens transaction holds the row right now.
  for (;;) {
    const client = await db.connect();
    let candidates = 0;
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ id: string }>(
        `SELECT gs.id FROM guest_sessions gs
          WHERE gs.migrated_at IS NULL AND gs.account_id IS NULL
            AND gs.created_at < NOW() - INTERVAL '2 days'
            AND NOT EXISTS (SELECT 1 FROM gardens g WHERE g.guest_session_id = gs.id)
            AND NOT EXISTS (SELECT 1 FROM seeds s WHERE s.guest_session_id = gs.id)
          LIMIT $1
          FOR UPDATE OF gs SKIP LOCKED`,
        [batchSize],
      );
      candidates = rows.length;
      if (candidates > 0) {
        const result = await client.query(
          `DELETE FROM guest_sessions gs
            WHERE gs.id = ANY($1::uuid[])
              AND NOT EXISTS (SELECT 1 FROM gardens g WHERE g.guest_session_id = gs.id)
              AND NOT EXISTS (SELECT 1 FROM seeds s WHERE s.guest_session_id = gs.id)`,
          [rows.map((r) => r.id)],
        );
        guestsAffected += result.rowCount ?? 0;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    if (candidates < batchSize) break;
  }

  // Account sessions 30 days past expiry (sign-outs, revocations, lapsed
  // logins). A row that still owns unmerged guest gardens or seeds is kept:
  // deleting it would cascade them away without queueing their R2 files.
  for (;;) {
    const result = await db.query(
      `DELETE FROM guest_sessions gs
        WHERE gs.id IN (
          SELECT gs2.id FROM guest_sessions gs2
           WHERE gs2.account_id IS NOT NULL
             AND gs2.expires_at < NOW() - INTERVAL '30 days'
             AND NOT EXISTS (SELECT 1 FROM gardens g WHERE g.guest_session_id = gs2.id)
             AND NOT EXISTS (SELECT 1 FROM seeds s WHERE s.guest_session_id = gs2.id)
           LIMIT $1)`,
      [batchSize],
    );
    guestsAffected += result.rowCount ?? 0;
    if ((result.rowCount ?? 0) < batchSize) break;
  }

  const tokensResult = await db.query(
    `DELETE FROM password_reset_tokens WHERE expires_at < NOW()`,
  );
  const verificationResult = await db.query(
    `DELETE FROM email_verification_tokens WHERE expires_at < NOW()`,
  );
  // Email-change tokens are kept after use or cancel (the per-recipient
  // cooldown counts them by created_at over 24h), but they hold email
  // addresses, so drop them after 30 days.
  const emailChangeResult = await db.query(
    `DELETE FROM email_change_tokens WHERE created_at < NOW() - INTERVAL '30 days'`,
  );
  // Revert links work for 7 days, but the rows hold both addresses, so drop
  // them on the same 30-day schedule as email-change tokens.
  const emailRevertResult = await db.query(
    `DELETE FROM email_revert_tokens WHERE created_at < NOW() - INTERVAL '30 days'`,
  );
  return {
    affected:
      guestsAffected +
      (tokensResult.rowCount ?? 0) +
      (verificationResult.rowCount ?? 0) +
      (emailChangeResult.rowCount ?? 0) +
      (emailRevertResult.rowCount ?? 0),
  };
}

// Read notifications are kept 90 days; unread ones are never purged.
export async function purgeReadNotifications(): Promise<{ affected: number }> {
  const result = await db.query(
    `DELETE FROM notifications WHERE read_at IS NOT NULL AND read_at < NOW() - INTERVAL '90 days'`,
  );
  return { affected: result.rowCount ?? 0 };
}

// The webhook's exactly-once check only needs recent ids: Stripe stops
// retrying an event after 3 days.
export async function purgeStripeEvents(): Promise<{ affected: number }> {
  const result = await db.query(
    `DELETE FROM stripe_events WHERE processed_at < NOW() - INTERVAL '90 days'`,
  );
  return { affected: result.rowCount ?? 0 };
}

// Usage events are behavioural data; keep 180 days. Deleted in batches so one
// night's backlog doesn't hold a long lock.
export async function purgeOldUsageEvents(): Promise<{ affected: number }> {
  let affected = 0;
  for (;;) {
    const result = await db.query(
      `DELETE FROM usage_events WHERE id IN (
         SELECT id FROM usage_events WHERE created_at < NOW() - INTERVAL '180 days' LIMIT 10000)`,
    );
    affected += result.rowCount ?? 0;
    if ((result.rowCount ?? 0) < 10000) return { affected };
  }
}

// Deletes accounts 30 days past their scheduled deletion. Stripe is torn down
// first; if that fails the account is kept for tomorrow. Its R2 folders (every
// seed, garden and harvest it owns, and its exports) are queued in the same
// transaction as the delete, so the drain owns them from then on.
export async function purgeScheduledAccounts(): Promise<{ affected: number; failed: number }> {
  const { rows } = await db.query<{
    id: number;
    stripe_subscription_id: string | null;
    stripe_customer_id: string | null;
  }>(
    `SELECT id, stripe_subscription_id, stripe_customer_id
       FROM accounts WHERE deletion_scheduled_at + INTERVAL '30 days' < NOW()`,
  );

  let affected = 0;
  let failed = 0;
  for (const { id, stripe_subscription_id, stripe_customer_id } of rows) {
    try {
      await teardownCustomer({ subId: stripe_subscription_id, customerId: stripe_customer_id });
    } catch (err) {
      logger.error('Could not end Stripe customer for purged account; keeping account', err, {
        accountId: id,
      });
      failed += 1;
      continue;
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      // Recheck under the lock: the user may have cancelled deletion meanwhile.
      const { rows: due } = await client.query(
        `SELECT 1 FROM accounts
          WHERE id = $1 AND deletion_scheduled_at + INTERVAL '30 days' < NOW()
          FOR UPDATE`,
        [id],
      );
      if (due.length === 0) {
        await client.query('ROLLBACK');
        continue;
      }
      const { rows: seeds } = await client.query<{ id: number }>(
        'SELECT id FROM seeds WHERE owner_id = $1',
        [id],
      );
      // Owned gardens, plus unmerged guest gardens of the account's sessions:
      // guest_sessions.account_id is ON DELETE SET NULL, so those sessions are
      // deleted explicitly below. Locked so no harvest moves in or out before
      // gardenFiles reads them (see queueDeletedGardens).
      const { rows: gardens } = await client.query<{ id: number }>(
        `SELECT id FROM gardens
          WHERE owner_id = $1
             OR guest_session_id IN (SELECT id FROM guest_sessions WHERE account_id = $1)
          FOR UPDATE`,
        [id],
      );
      const files: R2Deletion[] = [
        ...seeds.map((s): R2Deletion => ({ bucket: 'public', path: seedPhotoFolder(s.id), isPrefix: true })),
        ...[...(await gardenFiles(client, gardens.map((g) => g.id))).values()].flat(),
        { bucket: 'exports', path: exportFolder(id), isPrefix: true },
      ];
      await queueR2Deletions(client, files);
      // These keep the row with user_id NULL (ON DELETE SET NULL), and the
      // ratings have no FK at all, so they are deleted here.
      await client.query('DELETE FROM feedback_submissions WHERE user_id = $1', [id]);
      await client.query('DELETE FROM usage_events WHERE user_id = $1', [id]);
      await deleteAccountRatings(client, id);
      // Cascades the sessions' guest gardens and seeds.
      await client.query('DELETE FROM guest_sessions WHERE account_id = $1', [id]);
      await client.query('DELETE FROM accounts WHERE id = $1', [id]);
      await client.query('COMMIT');
      affected += 1;
    } catch (err) {
      // One bad account must not stop the others; it is retried tomorrow.
      await client.query('ROLLBACK').catch(() => {});
      logger.error('Could not purge account; keeping it', err, { accountId: id });
      failed += 1;
    } finally {
      client.release();
    }
  }
  return { affected, failed };
}

// Lifetime accounts have subscription_interval = 'lifetime', excluded by the
// IN clause below — this task must never touch them.
export async function checkSubscriptionDowngrades(): Promise<{ affected: number }> {
  // With billing off nobody pays, so a lapsed period end means nothing.
  if (getServerConfig().billing === 'off') {
    console.log('[nightly] checkSubscriptionDowngrades: skipped (billing is off)');
    return { affected: 0 };
  }
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

// Removes export jobs that are done with: complete ones past expiry, and
// failed or stuck ones over a day old (a failure can come after the upload, so
// their ZIP may exist). Each row's ZIP is queued in the same transaction as
// the row delete, so a row never goes without its file being queued.
export async function purgeExpiredExports(): Promise<{ affected: number }> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: number; account_id: number }>(
      `DELETE FROM data_export_jobs
        WHERE (status = 'complete' AND expires_at < NOW())
           OR (status IN ('failed', 'pending', 'processing')
               AND requested_at < NOW() - INTERVAL '1 day')
        RETURNING id, account_id`,
    );
    await queueR2Deletions(
      client,
      rows.map((r) => ({ bucket: 'exports', path: exportKey(r.account_id, r.id), isPrefix: false })),
    );
    await client.query('COMMIT');
    return { affected: rows.length };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Session-level advisory lock so two runs (an overlap, or a second process)
// never purge at once. Arbitrary constant; only this job uses it. Needs a
// direct Postgres connection: through a transaction-mode pooler (Neon
// -pooler) lock and unlock can hit different backends and the lock sticks.
export const NIGHTLY_LOCK_KEY = 7_302_118;

// The lock client comes from the web pool: holding it for the whole run would
// take one of the job pool's three connections. It sits idle, so the web
// statement cap never applies. If the lock connection drops mid-run the lock
// is lost and the run continues unguarded, which is acceptable for a
// once-daily job.
export async function runNightlyJob(): Promise<void> {
  const lockClient = await webDb.connect();
  // pg-pool removes its idle 'error' listener while a client is checked out; an
  // unhandled 'error' here would otherwise take the whole process down.
  const onLockLost = (err: Error) =>
    logger.error('[nightly] lock connection lost; run continues unlocked', err);
  lockClient.on('error', onLockLost);
  let releaseErr: Error | undefined;
  try {
    const { rows } = await lockClient.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [NIGHTLY_LOCK_KEY],
    );
    if (!rows[0].locked) {
      console.warn('[nightly] another run holds the lock; skipping');
      return;
    }
    try {
      await runNightlyTasks();
    } finally {
      try {
        await lockClient.query('SELECT pg_advisory_unlock($1)', [NIGHTLY_LOCK_KEY]);
      } catch (err) {
        // Destroying the connection ends its session, which drops the lock.
        releaseErr = err instanceof Error ? err : new Error(String(err));
      }
    }
  } finally {
    lockClient.off('error', onLockLost);
    lockClient.release(releaseErr);
  }
}

async function runNightlyTasks(): Promise<void> {
  const started = new Date();
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO job_runs (job_key, status, started_at)
     VALUES ('nightly', 'ok', $1) RETURNING id`,
    [started],
  );
  const runId = rows[0].id;
  const errors: string[] = [];

  const tasks: Array<[string, () => Promise<{ affected: number; failed?: number }>]> = [
    ['deriveGrowth', deriveGrowth],
    ['refreshGardenBadges', refreshGardenBadges],
    ['purgeExpiredGuests', purgeExpiredGuests],
    ['purgeReadNotifications', purgeReadNotifications],
    ['purgeStripeEvents', purgeStripeEvents],
    ['purgeOldUsageEvents', purgeOldUsageEvents],
    ['purgeScheduledAccounts', purgeScheduledAccounts],
    ['checkSubscriptionDowngrades', checkSubscriptionDowngrades],
    ['purgeExpiredExports', purgeExpiredExports],
    // Last: drains what tonight's purges queued.
    ['drainR2Deletions', () => drainR2Deletions()],
  ];

  for (const [name, task] of tasks) {
    try {
      const { affected, failed = 0 } = await task();
      if (failed > 0) {
        console.log(`[nightly] ${name}: ${affected} rows, ${failed} failed`);
        // Each failed item was already reported via logger.error.
        errors.push(`${name}: ${failed} item(s) failed`);
      } else {
        console.log(`[nightly] ${name}: ${affected} rows`);
      }
    } catch (err) {
      logger.error(`[nightly] ${name} failed`, err);
      errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Failures are recorded here and were reported above, so the run doesn't
  // throw for them; runNightlyJob rejects only when the job itself crashes.
  await db.query(
    `UPDATE job_runs SET status = $1, finished_at = NOW(), error_msg = $2
     WHERE id = $3`,
    [errors.length ? 'failed' : 'ok', errors.length ? errors.join('; ') : null, runId],
  );
}

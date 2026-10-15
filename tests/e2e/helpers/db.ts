import { Pool } from 'pg';
import * as bcrypt from 'bcrypt';

// Playwright can run multiple spec files in the same worker process (it only
// restarts the worker after a file with failures), so this module's cache —
// and this pool — can end up shared across files. Each file still calls its
// own closePool() in afterAll, so a lazily-recreated pool keeps every file
// working whether or not it happens to share a worker with another.
let pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
let ended = false;

function getPool(): Pool {
  if (ended) {
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    ended = false;
  }
  return pool;
}

export async function resetTestDb(): Promise<void> {
  await getPool().query(`
    TRUNCATE accounts, guest_sessions, gardens, beds, plantings,
             oauth_identities, password_reset_tokens
    RESTART IDENTITY CASCADE
  `);
}

export async function createTestUser(opts: {
  email?: string; password?: string;
  displayName?: string; isSupporter?: boolean;
} = {}): Promise<{ id: string; email: string; password: string }> {
  const email = opts.email ?? `test-${Date.now()}@example.com`;
  const password = opts.password ?? 'TestPass123!';
  const hash = await bcrypt.hash(password, 10);
  const result = await getPool().query<{ id: string }>(
    `INSERT INTO accounts (email, password_hash, display_name, zone, zone_location_label,
       email_verified, subscription_tier)
     VALUES ($1, $2, $3, '7b', 'Test City', true, $4) RETURNING id::text`,
    [email, hash, opts.displayName ?? 'Test User',
     opts.isSupporter ? 'supporter' : 'free']
  );
  return { id: result.rows[0].id, email, password };
}

export async function createTestGarden(accountId: string, name = 'Test Garden'):
    Promise<string> {
  const result = await getPool().query<{ id: string }>(
    `INSERT INTO gardens (owner_id, name, style, zone)
     VALUES ($1, $2, 'grid', '7b') RETURNING id::text`,
    [accountId, name]
  );
  return result.rows[0].id;
}

export async function createTestSeed(accountId: string,
    commonName = 'Test Basil', timing: {
      weeksToTransplant?: number; frostTolerance?: 'none' | 'light' | 'hard';
      maturityDaysMin?: number; maturityDaysMax?: number;
    } = {}): Promise<number> {
  const result = await getPool().query<{ id: number }>(
    `INSERT INTO seeds (owner_id, common_name, origin, weeks_to_transplant,
       frost_tolerance, maturity_days_min, maturity_days_max)
     VALUES ($1, $2, 'user_created', $3, $4, $5, $6) RETURNING id`,
    [accountId, commonName, timing.weeksToTransplant ?? null,
     timing.frostTolerance ?? null, timing.maturityDaysMin ?? null,
     timing.maturityDaysMax ?? null]
  );
  return result.rows[0].id;
}

// Community seed in cambium.seeds (not cleared by resetTestDb, so callers
// should use a unique name).
export async function createTestCambiumSeed(commonName: string): Promise<number> {
  const result = await getPool().query<{ id: number }>(
    `INSERT INTO cambium.seeds (common_name, source) VALUES ($1, 'editorial') RETURNING id`,
    [commonName]
  );
  return result.rows[0].id;
}

export async function closePool(): Promise<void> {
  if (ended) return;
  ended = true;
  await pool.end();
}

// Flip an account between free and supporter mid-test. The session's tier is
// read from the database on every request, so the next request sees it.
export async function setSubscriptionTier(
  accountId: string,
  tier: 'free' | 'supporter',
  billing?: { interval: 'monthly' | 'annual' | 'lifetime' | null; stripeSubscriptionId?: string | null },
): Promise<void> {
  if (!billing) {
    await getPool().query('UPDATE accounts SET subscription_tier = $2 WHERE id = $1', [accountId, tier]);
    return;
  }
  await getPool().query(
    `UPDATE accounts
        SET subscription_tier = $2, subscription_interval = $3, stripe_subscription_id = $4
      WHERE id = $1`,
    [accountId, tier, billing.interval, billing.stripeSubscriptionId ?? null],
  );
}

// Growth fields are written by the nightly job; tests set them directly. Stage
// 5 at 100 % with displayed_growth_stage already 5 so the canvas draws the
// harvest-ready marker without a stage-change pulse.
export async function setPlantingHarvestReady(plantingId: string): Promise<void> {
  await getPool().query(
    `UPDATE plantings
        SET growth_stage = 5, growth_stage_pct = 100, displayed_growth_stage = 5,
            harvest_ready = true, indicator_dismissed_at = NULL
      WHERE id = $1`,
    [plantingId],
  );
}

// Promote an account to admin (role is only settable via the admin API otherwise).
export async function setAccountRole(accountId: string, role: 'user' | 'admin'): Promise<void> {
  await getPool().query('UPDATE accounts SET role = $2 WHERE id = $1', [accountId, role]);
}

// Move a guest session's expiry. `signedCookie` is the raw _vernal_sid cookie
// value ("<token>.<sig>", possibly URL-encoded). `interval` is a Postgres
// interval literal evaluated against now(), e.g. '4 days 23 hours'.
export async function setGuestExpiry(signedCookie: string, interval: string): Promise<void> {
  const token = decodeURIComponent(signedCookie).split('.')[0];
  const result = await getPool().query(
    `UPDATE guest_sessions SET expires_at = now() + $2::interval WHERE token = $1`,
    [token, interval],
  );
  if (result.rowCount !== 1) throw new Error('setGuestExpiry: guest session not found');
}

// Moderation queue rows, inserted directly. `createdAt` is a Postgres interval
// literal subtracted from now() (e.g. '2 hours'), so tests can order items
// deterministically. resetTestDb's TRUNCATE ... CASCADE on accounts clears
// moderation_items and feedback_submissions (both reference accounts).
export async function createModerationCorrection(opts: {
  cambiumSeedId: number; submittedBy: string | null; correctionText: string; createdAt?: string;
}): Promise<number> {
  const result = await getPool().query<{ id: number }>(
    `INSERT INTO moderation_items (type, cambium_seed_id, submitted_by, content, created_at)
     VALUES ('correction', $1, $2, $3, now() - $4::interval) RETURNING id`,
    [opts.cambiumSeedId, opts.submittedBy, JSON.stringify({ correctionText: opts.correctionText }),
     opts.createdAt ?? '0 seconds'],
  );
  return result.rows[0].id;
}

// A new-seed submission for a personal seed; also marks the seed's
// contribution as pending, as the real submit flow does.
export async function createModerationNewSeed(opts: {
  seedId: number; submittedBy: string | null; content: Record<string, unknown>; createdAt?: string;
}): Promise<number> {
  await getPool().query(`UPDATE seeds SET contribution_status = 'pending' WHERE id = $1`, [opts.seedId]);
  const result = await getPool().query<{ id: number }>(
    `INSERT INTO moderation_items (type, seed_id, submitted_by, content, created_at)
     VALUES ('new_seed', $1, $2, $3, now() - $4::interval) RETURNING id`,
    [opts.seedId, opts.submittedBy, JSON.stringify(opts.content), opts.createdAt ?? '0 seconds'],
  );
  return result.rows[0].id;
}

// A feedback submission; omit userId for a guest. `createdAt` as above.
export async function createFeedback(opts: {
  userId?: string | null; category: 'bug' | 'feature_request' | 'general' | 'data_quality';
  message: string; sourceSurface?: string | null; appVersion?: string | null; createdAt?: string;
}): Promise<number> {
  const result = await getPool().query<{ id: number }>(
    `INSERT INTO feedback_submissions (user_id, category, message, source_surface, app_version,
       created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, now() - $6::interval, now() - $6::interval) RETURNING id`,
    [opts.userId ?? null, opts.category, opts.message, opts.sourceSurface ?? null,
     opts.appVersion ?? null, opts.createdAt ?? '0 seconds'],
  );
  return result.rows[0].id;
}

// The moderation queue row for a seed that has been submitted as a contribution.
export async function getModerationItemId(seedId: number): Promise<number> {
  const result = await getPool().query<{ id: number }>(
    `SELECT id FROM moderation_items WHERE seed_id = $1 AND type = 'new_seed' ORDER BY id DESC LIMIT 1`,
    [seedId],
  );
  if (result.rows.length === 0) throw new Error(`No moderation item for seed ${seedId}`);
  return result.rows[0].id;
}

// Spacing on a personal seed (createTestSeed leaves it null). The plantings API
// reports it as the planting's spacingInches.
export async function setSeedSpacing(seedId: number, spacingInches: number): Promise<void> {
  await getPool().query('UPDATE seeds SET spacing_inches = $2 WHERE id = $1', [seedId, spacingInches]);
}

// A Cambium companion relationship, stored in both directions so either
// seed's companions list reports it. Confidence 100 clears the service's
// display threshold. cambium.* is not cleared by resetTestDb; the rows go
// with their seeds (ON DELETE CASCADE), so use uniquely named seeds.
export async function createCambiumCompanion(
  seedId: number, companionSeedId: number,
  relationship: 'beneficial' | 'antagonistic' | 'neutral',
): Promise<void> {
  await getPool().query(
    `INSERT INTO cambium.companions (seed_id, companion_seed_id, relationship, confidence, source)
     VALUES ($1, $2, $3, 100, 'e2e'), ($2, $1, $3, 100, 'e2e')
     ON CONFLICT (seed_id, companion_seed_id) DO UPDATE SET relationship = EXCLUDED.relationship`,
    [seedId, companionSeedId, relationship],
  );
}

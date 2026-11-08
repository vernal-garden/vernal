import type { APIRequestContext } from '@playwright/test';
import { Pool } from 'pg';
import * as bcrypt from 'bcrypt';
import { createHash } from 'crypto';

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

// Removes cambium.seeds rows whose common_name matches any of the LIKE
// patterns (e.g. 'Mobcat %'), for a spec's afterAll since resetTestDb leaves
// cambium.* alone. A stamp-prefix pattern also clears earlier runs' leftovers.
// cambium.companions and cambium.seed_ratings go with them (ON DELETE
// CASCADE); public-schema cambium_seed_id columns have no FK, so nothing
// blocks the delete. Returns the number of seeds deleted.
export async function deleteCambiumSeedsLike(...patterns: string[]): Promise<number> {
  if (patterns.length === 0) return 0;
  const result = await getPool().query(
    'DELETE FROM cambium.seeds WHERE common_name LIKE ANY($1::text[])',
    [patterns],
  );
  return result.rowCount ?? 0;
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

// Session rows are keyed by sha256(token) hex (migration 021), as src/lib/tokens.ts hashes them.
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// Move a guest session's expiry. `signedCookie` is the raw _vernal_sid cookie
// value ("<token>.<sig>", possibly URL-encoded). `interval` is a Postgres
// interval literal evaluated against now(), e.g. '4 days 23 hours'.
export async function setGuestExpiry(signedCookie: string, interval: string): Promise<void> {
  const token = decodeURIComponent(signedCookie).split('.')[0];
  const result = await getPool().query(
    `UPDATE guest_sessions SET expires_at = now() + $2::interval WHERE token_hash = $1`,
    [hashToken(token), interval],
  );
  if (result.rowCount !== 1) throw new Error('setGuestExpiry: guest session not found');
}

// Deletes the session row behind a signed cookie value, as the nightly purge
// does, leaving the browser holding a cookie that verifies but points nowhere.
export async function deleteGuestSession(signedCookie: string): Promise<void> {
  const token = decodeURIComponent(signedCookie).split('.')[0];
  const result = await getPool().query('DELETE FROM guest_sessions WHERE token_hash = $1', [hashToken(token)]);
  if (result.rowCount !== 1) throw new Error('deleteGuestSession: session not found');
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

export interface BetaState {
  gateOn: boolean;
  guestModeOn: boolean;
  supporterAccessOn: boolean;
  gateFirstOnAt: Date | null;
  invites: string[];
}

const BETA_DEFAULTS: BetaState = {
  gateOn: false, guestModeOn: true, supporterAccessOn: true, gateFirstOnAt: null, invites: [],
};

// Writes the beta_settings row and the invite list directly; anything left out
// takes its default, so setBetaState(admin) restores today's behavior.
//
// The server caches the switches for 30 seconds and only a PATCH that changes a
// value clears the cache (one that repeats the stored value is a no-op). So the
// Supporter switch is written inverted and `admin`, a signed-in admin's context,
// PATCHes it to its real value: always a change, whatever state the row was in.
// The /api/config read then proves the server is answering with the new state.
export async function setBetaState(admin: APIRequestContext, state: Partial<BetaState> = {}): Promise<void> {
  const next = { ...BETA_DEFAULTS, ...state };
  await getPool().query(
    `UPDATE beta_settings
        SET gate_on = $1, guest_mode_on = $2, supporter_access_on = $3, gate_first_on_at = $4,
            updated_at = now()
      WHERE id = 1`,
    [next.gateOn, next.guestModeOn, !next.supporterAccessOn, next.gateFirstOnAt],
  );
  await getPool().query('DELETE FROM beta_invites');
  await getPool().query('INSERT INTO beta_invites (email) SELECT unnest($1::text[])', [next.invites]);

  const patch = await admin.patch('/api/admin/beta/settings', {
    data: { supporterAccessOn: next.supporterAccessOn },
  });
  if (!patch.ok()) throw new Error(`setBetaState: PATCH failed with ${patch.status()}`);
  const overview = await patch.json();
  if (overview.supporterAccessOn !== next.supporterAccessOn) {
    throw new Error(`setBetaState: PATCH left supporterAccessOn at ${overview.supporterAccessOn}`);
  }

  const config = await (await admin.get('/api/config')).json();
  if (config.betaGate !== next.gateOn || config.guestMode !== next.guestModeOn) {
    throw new Error(`setBetaState: server still reports ${JSON.stringify(config)}`);
  }
}

// Makes an account a participant who hasn't accepted the terms. findSession reads
// this on every request, so it holds an open session at once, with no cache to wait for.
export async function holdAtBetaTerms(accountId: string): Promise<void> {
  await getPool().query('UPDATE accounts SET beta_participant_at = now() WHERE id = $1', [accountId]);
}

// hasCustomer on GET /api/subscription reads this column; nothing here reaches Stripe.
export async function setStripeCustomer(accountId: string, customerId: string): Promise<void> {
  await getPool().query('UPDATE accounts SET stripe_customer_id = $2 WHERE id = $1', [accountId, customerId]);
}

export async function scheduleDeletion(accountId: string): Promise<void> {
  await getPool().query('UPDATE accounts SET deletion_scheduled_at = now() WHERE id = $1', [accountId]);
}

// Undoes setStripeCustomer and every scheduled deletion, whether scheduled above
// or through the app, for a spec's cleanup. Runs after a failed test too, so no
// account stays frozen or carries a fake customer until the next resetTestDb.
export async function clearDeletionsAndCustomers(): Promise<void> {
  await getPool().query(
    `UPDATE accounts SET deletion_scheduled_at = NULL, stripe_customer_id = NULL
      WHERE deletion_scheduled_at IS NOT NULL OR stripe_customer_id IS NOT NULL`,
  );
}

export async function countGuestSessions(): Promise<number> {
  const result = await getPool().query<{ count: number }>('SELECT COUNT(*)::int AS count FROM guest_sessions');
  return result.rows[0].count;
}

export async function getBetaInviteEmails(): Promise<string[]> {
  const result = await getPool().query<{ email: string }>('SELECT email FROM beta_invites ORDER BY email');
  return result.rows.map((r) => r.email);
}

// The beta columns of the account with this email, or null when there is none.
export async function getBetaAccount(email: string): Promise<{
  betaParticipantAt: Date | null; betaTermsVersion: string | null; betaTermsAcceptedAt: Date | null;
} | null> {
  const result = await getPool().query<{
    beta_participant_at: Date | null; beta_terms_version: string | null; beta_terms_accepted_at: Date | null;
  }>(
    'SELECT beta_participant_at, beta_terms_version, beta_terms_accepted_at FROM accounts WHERE email = $1',
    [email],
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    betaParticipantAt: row.beta_participant_at,
    betaTermsVersion: row.beta_terms_version,
    betaTermsAcceptedAt: row.beta_terms_accepted_at,
  };
}

// What a claim leaves behind (a Google sign-in on a verified account with a
// password): the Terms acceptance cleared and claimed_at set. Holds an open
// session at once, as holdAtBetaTerms does.
export async function markClaimed(accountId: string): Promise<void> {
  await getPool().query(
    'UPDATE accounts SET claimed_at = now(), terms_version = NULL, terms_accepted_at = NULL WHERE id = $1',
    [accountId],
  );
}

export async function getTermsAcceptance(email: string): Promise<{
  termsVersion: string | null; termsAcceptedAt: Date | null;
} | null> {
  const result = await getPool().query<{ terms_version: string | null; terms_accepted_at: Date | null }>(
    'SELECT terms_version, terms_accepted_at FROM accounts WHERE email = $1',
    [email],
  );
  if (result.rows.length === 0) return null;
  return { termsVersion: result.rows[0].terms_version, termsAcceptedAt: result.rows[0].terms_accepted_at };
}

// An account whose address was never verified (anyone could have registered it).
export async function markUnverified(accountId: string): Promise<void> {
  await getPool().query('UPDATE accounts SET email_verified = false WHERE id = $1', [accountId]);
}

export async function markVerified(accountId: string): Promise<void> {
  await getPool().query('UPDATE accounts SET email_verified = true WHERE id = $1', [accountId]);
}

export async function setAccountEmail(accountId: string, email: string): Promise<void> {
  await getPool().query('UPDATE accounts SET email = $2 WHERE id = $1', [accountId, email]);
}

// A live password reset token for the account, as the reset email would carry.
export async function createResetToken(accountId: string): Promise<string> {
  const token = `e2e-reset-${accountId}-${Date.now()}`;
  await getPool().query(
    `INSERT INTO password_reset_tokens (account_id, token_hash, expires_at)
     VALUES ($1, $2, now() + interval '1 hour')`,
    [accountId, hashToken(token)],
  );
  return token;
}

// The account's id and whether it was displaced, by id.
export async function getDisplacement(accountId: string): Promise<{ email: string; displaced: boolean; deleted: boolean }> {
  const result = await getPool().query<{ email: string; displaced: boolean; deleted: boolean }>(
    `SELECT email, displaced_at IS NOT NULL AS displaced, deletion_scheduled_at IS NOT NULL AS deleted
       FROM accounts WHERE id = $1`,
    [accountId],
  );
  return result.rows[0];
}

// A live verification token for the account's current address, as the
// verification email would carry (the same token serves the "This wasn't me" link).
// expiresIn: a Postgres interval, e.g. '1 minute' for a link inside the
// 2-minute guard on removal.
export async function createVerificationToken(
  accountId: string,
  { expiresIn = '24 hours' }: { expiresIn?: string } = {},
): Promise<string> {
  const token = `e2e-verify-${accountId}-${Date.now()}`;
  await getPool().query(
    `INSERT INTO email_verification_tokens (account_id, email, token_hash, expires_at)
     SELECT id, email, $2, now() + $3::interval FROM accounts WHERE id = $1`,
    [accountId, hashToken(token), expiresIn],
  );
  return token;
}

// Whether the token is still there and unused (a displaced account's tokens are deleted).
export async function isVerificationTokenLive(token: string): Promise<boolean> {
  const result = await getPool().query<{ live: boolean }>(
    'SELECT used_at IS NULL AS live FROM email_verification_tokens WHERE token_hash = $1',
    [hashToken(token)],
  );
  return result.rows[0]?.live ?? false;
}

// A Google sign-in held by the callback because it matched an unverified
// account, as resolveAccount.ts stores it (only the SHA-256 of the token and
// of the browser cookie's value). The access token is never decrypted on
// completion, only copied, so any bytes do. The caller puts browserToken in
// the _vernal_takeover cookie, as the callback would.
export async function createPendingTakeover(
  accountId: string,
  opts: { expired?: boolean; providerUserId?: string } = {},
): Promise<{ token: string; browserToken: string }> {
  const token = `e2e-takeover-${accountId}-${Date.now()}`;
  const browserToken = `e2e-takeover-browser-${accountId}-${Date.now()}`;
  await getPool().query(
    `INSERT INTO pending_takeovers
       (token_hash, account_id, provider, provider_user_id, email, display_name, access_token_encrypted,
        return_to, expires_at, browser_hash)
     SELECT $2, id, 'google', $3, email, 'Google Owner', $5, '/',
            now() + CASE WHEN $4::boolean THEN interval '-1 minute' ELSE interval '15 minutes' END, $6
       FROM accounts WHERE id = $1`,
    [accountId, hashToken(token), opts.providerUserId ?? `e2e-google-${accountId}`, opts.expired ?? false,
     Buffer.from('e2e-not-a-real-token'), hashToken(browserToken)],
  );
  return { token, browserToken };
}

// What the unverified-account question leaves on an account, by id.
export async function getAccountState(accountId: string): Promise<{
  emailVerified: boolean; claimed: boolean; displaced: boolean; hasPassword: boolean;
}> {
  const result = await getPool().query<{
    email_verified: boolean; claimed: boolean; displaced: boolean; has_password: boolean;
  }>(
    `SELECT email_verified, claimed_at IS NOT NULL AS claimed, displaced_at IS NOT NULL AS displaced,
            password_hash IS NOT NULL AS has_password
       FROM accounts WHERE id = $1`,
    [accountId],
  );
  const row = result.rows[0];
  return { emailVerified: row.email_verified, claimed: row.claimed, displaced: row.displaced, hasPassword: row.has_password };
}

export async function getAccountIdByEmail(email: string): Promise<string | null> {
  const result = await getPool().query<{ id: string }>('SELECT id::text FROM accounts WHERE email = $1', [email]);
  return result.rows[0]?.id ?? null;
}

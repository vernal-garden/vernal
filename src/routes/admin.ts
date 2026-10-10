import { Router, type Response } from 'express';
import { db } from '../lib/db';
import { requireAdmin } from '../middleware/auth';
import { isNumericId } from '../lib/validation';
import { logger } from '../lib/logger';
import { EVENT_KEYS, MICRO_FEEDBACK_TRIGGERS } from '../lib/eventKeys';
import { getRequestMetrics } from '../lib/requestMetrics';

const router = Router();
router.use(requireAdmin);

const ACCOUNT_LIST_COLUMNS = `
  id, email, display_name, role, subscription_tier, subscription_interval,
  subscription_period_end, last_active_at, created_at
`;

// ── GET /stats ───────────────────────────────────────────────────────────────

router.get('/stats', async (_req, res) => {
  try {
    const [accountsResult, subscriptionsResult] = await Promise.all([
      db.query(`
        SELECT
          COUNT(*)::int                                                    AS total,
          COUNT(*) FILTER (WHERE created_at > now() - interval '30 days')::int
                                                                            AS new_last_30d,
          COUNT(*) FILTER (WHERE created_at > now() - interval '7 days')::int
                                                                            AS new_last_7d,
          COUNT(*) FILTER (WHERE last_active_at > now() - interval '30 days')::int
                                                                            AS active_last_30d
        FROM accounts
      `),
      db.query(`
        SELECT subscription_tier, COUNT(*)::int AS count
        FROM accounts
        GROUP BY subscription_tier
        ORDER BY count DESC
      `),
    ]);

    res.json({
      accounts: accountsResult.rows[0],
      subscriptions: subscriptionsResult.rows,
    });
  } catch (err) {
    console.error('GET /admin/stats error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /accounts ────────────────────────────────────────────────────────────

router.get('/accounts', async (req, res) => {
  try {
    const email = req.query.email as string | undefined;

    if (email) {
      const result = await db.query(
        `SELECT ${ACCOUNT_LIST_COLUMNS} FROM accounts WHERE email ILIKE $1 ORDER BY created_at DESC LIMIT 20`,
        [`%${email}%`],
      );
      res.json({ data: result.rows });
      return;
    }

    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = 50;
    const offset = (page - 1) * limit;

    const [dataResult, countResult] = await Promise.all([
      db.query(
        `SELECT ${ACCOUNT_LIST_COLUMNS} FROM accounts ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
        [limit, offset],
      ),
      db.query('SELECT COUNT(*)::int AS total FROM accounts'),
    ]);

    res.json({ data: dataResult.rows, page, total: countResult.rows[0].total });
  } catch (err) {
    console.error('GET /admin/accounts error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /accounts/:id ─────────────────────────────────────────────────────────

router.get('/accounts/:id', async (req, res) => {
  try {
    const rawId = req.params.id as string;
    if (!isNumericId(rawId)) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const id = parseInt(rawId, 10);

    const [accountResult, gardenCountResult] = await Promise.all([
      db.query(
        `SELECT id, email, display_name, zone, zone_location_label, role,
                subscription_tier, stripe_customer_id, stripe_subscription_id,
                subscription_interval, subscription_period_end,
                subscription_cancelled_at, last_active_at, created_at, updated_at
         FROM accounts WHERE id = $1`,
        [id],
      ),
      db.query('SELECT COUNT(*)::int AS garden_count FROM gardens WHERE owner_id = $1', [id]),
    ]);

    if (accountResult.rows.length === 0) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    res.json({
      ...accountResult.rows[0],
      gardenCount: gardenCountResult.rows[0].garden_count,
    });
  } catch (err) {
    console.error('GET /admin/accounts/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ══ Phase 37 — admin dashboard API ═══════════════════════════════════════════

// Calendar boundaries (day / week / month buckets, "this month") are Pacific.
// A fixed constant — safe to inline into SQL.
const TZ = 'America/Los_Angeles';
const PAGE_SIZE = 50;
const MAX_PAGE = 100_000;
const PG_INT_MAX = 2_147_483_647;

// isNumericId plus an int4 range check, so an oversized id is a 400 rather
// than a Postgres "out of range" 500.
function parseIdParam(raw: unknown): number | null {
  if (!isNumericId(raw)) return null;
  const id = Number(raw);
  return id >= 1 && id <= PG_INT_MAX ? id : null;
}

// Query values can arrive as arrays (?a=1&a=2) — only plain strings count.
function queryString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parsePage(value: unknown): number {
  const page = parseInt(queryString(value) ?? '', 10);
  return Number.isFinite(page) && page >= 1 ? Math.min(page, MAX_PAGE) : 1;
}

// Whitelist lookup that ignores inherited keys ('constructor', 'toString').
function lookup<T>(map: Record<string, T>, key: string | undefined): T | undefined {
  return key !== undefined && Object.hasOwn(map, key) ? map[key] : undefined;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function sendInvalidId(res: Response) {
  res.status(400).json({ error: 'Invalid id' });
}

function sendServerError(res: Response, label: string, err: unknown) {
  logger.error(`${label} error`, err);
  res.status(500).json({ error: 'Internal server error' });
}

// ── PATCH /accounts/:id/tier ─────────────────────────────────────────────────

const TIERS = ['free', 'supporter'] as const;

router.patch('/accounts/:id/tier', async (req, res) => {
  const id = parseIdParam(req.params.id);
  if (id === null) return sendInvalidId(res);

  const { tier } = (req.body ?? {}) as { tier?: unknown };
  if (typeof tier !== 'string' || !(TIERS as readonly string[]).includes(tier)) {
    res.status(400).json({ error: 'tier must be one of: free, supporter' });
    return;
  }

  try {
    const result = await db.query(
      'UPDATE accounts SET subscription_tier = $1, updated_at = NOW() WHERE id = $2 RETURNING id',
      [tier, id],
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    logger.info('admin tier override', {
      targetAccountId: id,
      tier,
      adminId: req.session!.account!.id,
    });
    res.json({ id, subscriptionTier: tier });
  } catch (err) {
    sendServerError(res, 'PATCH /admin/accounts/:id/tier', err);
  }
});

// ── PATCH /accounts/:id/role ─────────────────────────────────────────────────

const ROLES = ['user', 'admin'] as const;

router.patch('/accounts/:id/role', async (req, res) => {
  const id = parseIdParam(req.params.id);
  if (id === null) return sendInvalidId(res);

  const adminId = req.session!.account!.id;
  if (id === adminId) {
    res.status(403).json({ error: 'Cannot change your own role.' });
    return;
  }

  const { role } = (req.body ?? {}) as { role?: unknown };
  if (typeof role !== 'string' || !(ROLES as readonly string[]).includes(role)) {
    res.status(400).json({ error: 'role must be one of: user, admin' });
    return;
  }

  try {
    const result = await db.query(
      'UPDATE accounts SET role = $1, updated_at = NOW() WHERE id = $2 RETURNING id',
      [role, id],
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    logger.info('admin role change', { targetAccountId: id, role, adminId });
    res.json({ id, role });
  } catch (err) {
    sendServerError(res, 'PATCH /admin/accounts/:id/role', err);
  }
});

// ── Seed DB ──────────────────────────────────────────────────────────────────

const UNRESOLVED = `('new', 'under_review')`;

router.get('/seeds/summary', async (_req, res) => {
  try {
    const [seedsResult, moderationResult] = await Promise.all([
      db.query(`
        SELECT
          COUNT(*)::int                                           AS total_seeds,
          COUNT(*) FILTER (WHERE source = 'community')::int       AS community_seeds,
          COUNT(*) FILTER (
            WHERE date_trunc('month', created_at AT TIME ZONE '${TZ}')
                = date_trunc('month', now() AT TIME ZONE '${TZ}')
          )::int                                                  AS added_this_month
        FROM cambium.seeds
      `),
      db.query(
        `SELECT COUNT(*)::int AS pending FROM moderation_items WHERE status IN ${UNRESOLVED}`,
      ),
    ]);
    const s = seedsResult.rows[0];
    res.json({
      totalSeeds: s.total_seeds,
      communitySeeds: s.community_seeds,
      pendingModeration: moderationResult.rows[0].pending,
      addedThisMonth: s.added_this_month,
    });
  } catch (err) {
    sendServerError(res, 'GET /admin/seeds/summary', err);
  }
});

const SEED_SOURCE_EXPR = `CASE WHEN s.source = 'community' THEN 'community' ELSE 'cambium' END`;

const SEED_SORTS: Record<string, string> = {
  common_name: 's.common_name',
  scientific_name: 's.scientific_name',
  plant_family: 's.plant_family',
  source: SEED_SOURCE_EXPR,
  open_corrections: 'COALESCE(oc.n, 0)',
  created_at: 's.created_at',
};

router.get('/seeds', async (req, res) => {
  try {
    const q = queryString(req.query.q)?.trim();
    const source = queryString(req.query.source);
    const hasCorrections = queryString(req.query.hasCorrections) === 'true';
    const sortExpr = lookup(SEED_SORTS, queryString(req.query.sort)) ?? SEED_SORTS.common_name;
    const dir = queryString(req.query.dir) === 'desc' ? 'DESC' : 'ASC';
    const page = parsePage(req.query.page);

    const where: string[] = [];
    const params: unknown[] = [];
    if (q) {
      params.push(`%${escapeLike(q)}%`);
      where.push(`(s.common_name ILIKE $${params.length} OR s.scientific_name ILIKE $${params.length})`);
    }
    if (source === 'community') where.push(`s.source = 'community'`);
    else if (source === 'cambium') where.push(`s.source IN ('openfarm', 'editorial')`);
    if (hasCorrections) where.push('COALESCE(oc.n, 0) > 0');

    const fromSql = `
      FROM cambium.seeds s
      LEFT JOIN (
        SELECT cambium_seed_id, COUNT(*)::int AS n
        FROM moderation_items
        WHERE type = 'correction' AND status IN ${UNRESOLVED} AND cambium_seed_id IS NOT NULL
        GROUP BY cambium_seed_id
      ) oc ON oc.cambium_seed_id = s.id
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
    `;

    const [dataResult, countResult] = await Promise.all([
      db.query(
        `SELECT s.id, s.common_name, s.scientific_name, s.plant_family,
                ${SEED_SOURCE_EXPR} AS source, s.source AS raw_source,
                s.moderation_status, COALESCE(oc.n, 0)::int AS open_corrections, s.created_at
         ${fromSql}
         ORDER BY ${sortExpr} ${dir}, s.id ${dir}
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, PAGE_SIZE, (page - 1) * PAGE_SIZE],
      ),
      db.query(`SELECT COUNT(*)::int AS total ${fromSql}`, params),
    ]);

    res.json({
      data: dataResult.rows.map((r) => ({
        id: r.id,
        commonName: r.common_name,
        scientificName: r.scientific_name,
        plantFamily: r.plant_family,
        source: r.source,
        rawSource: r.raw_source,
        moderationStatus: r.moderation_status,
        openCorrections: r.open_corrections,
        createdAt: r.created_at,
      })),
      page,
      total: countResult.rows[0].total,
    });
  } catch (err) {
    sendServerError(res, 'GET /admin/seeds', err);
  }
});

// ── Moderation ───────────────────────────────────────────────────────────────

// Unresolved tabs aren't paged, but still get a server-side ceiling.
const MODERATION_UNRESOLVED_CAP = 500;

const MODERATION_TABS: Record<string, string> = {
  all: `m.status IN ${UNRESOLVED}`,
  corrections: `m.status IN ${UNRESOLVED} AND m.type = 'correction'`,
  new_seeds: `m.status IN ${UNRESOLVED} AND m.type = 'new_seed'`,
  resolved: `m.status IN ('approved', 'rejected')`,
};

const SUBMITTER_NAME_EXPR = `COALESCE(NULLIF(TRIM(a.display_name), ''), a.email)`;

const MODERATION_LIST_SELECT = `
  SELECT m.id, m.type, m.status, m.created_at, m.resolved_at, m.resolution_note,
         CASE WHEN m.type = 'correction'
              THEN COALESCE(cs.common_name, m.content->>'seedName')
              ELSE COALESCE(m.content->>'commonName', ps.common_name)
         END AS seed_name,
         ${SUBMITTER_NAME_EXPR} AS submitter_name
  FROM moderation_items m
  LEFT JOIN cambium.seeds cs ON m.type = 'correction' AND cs.id = m.cambium_seed_id
  LEFT JOIN seeds ps ON ps.id = m.seed_id
  LEFT JOIN accounts a ON a.id = m.submitted_by
`;

router.get('/moderation', async (req, res) => {
  try {
    const rawTab = queryString(req.query.tab);
    const tab = rawTab !== undefined && lookup(MODERATION_TABS, rawTab) ? rawTab : 'all';
    const isResolved = tab === 'resolved';
    const page = isResolved ? parsePage(req.query.page) : 1;

    const listQuery = isResolved
      ? db.query(
          `${MODERATION_LIST_SELECT}
           WHERE ${MODERATION_TABS.resolved}
           ORDER BY m.resolved_at DESC NULLS LAST, m.id DESC
           LIMIT $1 OFFSET $2`,
          [PAGE_SIZE, (page - 1) * PAGE_SIZE],
        )
      : db.query(
          `${MODERATION_LIST_SELECT}
           WHERE ${MODERATION_TABS[tab]}
           ORDER BY m.created_at DESC, m.id DESC
           LIMIT $1`,
          [MODERATION_UNRESOLVED_CAP],
        );

    const [listResult, countsResult] = await Promise.all([
      listQuery,
      db.query(`
        SELECT
          COUNT(*) FILTER (WHERE status IN ${UNRESOLVED})::int                          AS all_count,
          COUNT(*) FILTER (WHERE status IN ${UNRESOLVED} AND type = 'correction')::int  AS corrections,
          COUNT(*) FILTER (WHERE status IN ${UNRESOLVED} AND type = 'new_seed')::int    AS new_seeds,
          COUNT(*) FILTER (WHERE status IN ('approved', 'rejected'))::int               AS resolved
        FROM moderation_items
      `),
    ]);

    const c = countsResult.rows[0];
    const data = listResult.rows.map((r) => ({
      id: r.id,
      type: r.type,
      status: r.status,
      createdAt: r.created_at,
      resolvedAt: r.resolved_at,
      resolutionNote: r.resolution_note,
      seedName: r.seed_name,
      submitterName: r.submitter_name,
    }));

    res.json({
      tab,
      data,
      counts: { all: c.all_count, corrections: c.corrections, newSeeds: c.new_seeds, resolved: c.resolved },
      page,
      total: isResolved ? c.resolved : data.length,
    });
  } catch (err) {
    sendServerError(res, 'GET /admin/moderation', err);
  }
});

router.get('/moderation/:id', async (req, res) => {
  const id = parseIdParam(req.params.id);
  if (id === null) return sendInvalidId(res);

  try {
    const result = await db.query(
      `SELECT m.id, m.type, m.status, m.content, m.resolution_note, m.created_at, m.resolved_at,
              cs.id AS cs_id, cs.common_name AS cs_common_name, cs.scientific_name AS cs_scientific_name,
              ps.id AS ps_id, ps.common_name AS ps_common_name, ps.scientific_name AS ps_scientific_name,
              ps.contribution_status AS ps_contribution_status,
              a.id AS a_id, a.display_name AS a_display_name, a.email AS a_email
       FROM moderation_items m
       LEFT JOIN cambium.seeds cs ON m.type = 'correction' AND cs.id = m.cambium_seed_id
       LEFT JOIN seeds ps ON m.type = 'new_seed' AND ps.id = m.seed_id
       LEFT JOIN accounts a ON a.id = m.submitted_by
       WHERE m.id = $1`,
      [id],
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const r = result.rows[0];

    let seed = null;
    if (r.type === 'correction' && r.cs_id !== null) {
      seed = { id: r.cs_id, commonName: r.cs_common_name, scientificName: r.cs_scientific_name };
    } else if (r.type === 'new_seed' && r.ps_id !== null) {
      seed = {
        id: r.ps_id,
        commonName: r.ps_common_name,
        scientificName: r.ps_scientific_name,
        contributionStatus: r.ps_contribution_status,
      };
    }

    const seedName =
      r.type === 'correction'
        ? (r.cs_common_name ?? r.content?.seedName ?? null)
        : (r.content?.commonName ?? r.ps_common_name ?? null);

    res.json({
      id: r.id,
      type: r.type,
      status: r.status,
      content: r.content,
      resolutionNote: r.resolution_note,
      createdAt: r.created_at,
      resolvedAt: r.resolved_at,
      seedName,
      seed,
      submitter:
        r.a_id === null ? null : { id: r.a_id, displayName: r.a_display_name, email: r.a_email },
    });
  } catch (err) {
    sendServerError(res, 'GET /admin/moderation/:id', err);
  }
});

const MODERATION_ACTIONS = ['approve', 'reject', 'defer'] as const;
type ModerationAction = (typeof MODERATION_ACTIONS)[number];

router.patch('/moderation/:id', async (req, res) => {
  const id = parseIdParam(req.params.id);
  if (id === null) return sendInvalidId(res);

  const body = (req.body ?? {}) as { action?: unknown; note?: unknown };
  const action = body.action;
  if (typeof action !== 'string' || !(MODERATION_ACTIONS as readonly string[]).includes(action)) {
    res.status(400).json({ error: 'action must be one of: approve, reject, defer' });
    return;
  }
  if (body.note !== undefined && body.note !== null && typeof body.note !== 'string') {
    res.status(400).json({ error: 'note must be a string' });
    return;
  }
  const trimmed = typeof body.note === 'string' ? body.note.trim() : '';
  if (trimmed.length > 2000) {
    res.status(400).json({ error: 'note must be 2000 characters or fewer' });
    return;
  }
  const note = trimmed.length > 0 ? trimmed : null;

  let client;
  try {
    client = await db.connect();
  } catch (err) {
    sendServerError(res, 'PATCH /admin/moderation/:id', err);
    return;
  }

  try {
    await client.query('BEGIN');
    const existing = await client.query<{ type: string; status: string; seed_id: number | null }>(
      'SELECT type, status, seed_id FROM moderation_items WHERE id = $1 FOR UPDATE',
      [id],
    );
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const item = existing.rows[0];
    if (item.status === 'approved' || item.status === 'rejected') {
      await client.query('ROLLBACK');
      res.status(409).json({ error: 'This item is already resolved.' });
      return;
    }

    const updated =
      (action as ModerationAction) === 'defer'
        ? await client.query(
            `UPDATE moderation_items SET status = 'under_review', resolved_at = NULL
             WHERE id = $1 RETURNING id, status, resolution_note, resolved_at`,
            [id],
          )
        : await client.query(
            `UPDATE moderation_items SET status = $1, resolution_note = $2, resolved_at = NOW()
             WHERE id = $3 RETURNING id, status, resolution_note, resolved_at`,
            [action === 'approve' ? 'approved' : 'rejected', note, id],
          );

    if (item.type === 'new_seed' && item.seed_id !== null && action !== 'defer') {
      await client.query(
        'UPDATE seeds SET contribution_status = $1, updated_at = NOW() WHERE id = $2',
        [action === 'approve' ? 'approved' : 'rejected', item.seed_id],
      );
    }

    await client.query('COMMIT');

    logger.info('admin moderation action', {
      moderationItemId: id,
      action,
      adminId: req.session!.account!.id,
    });

    const u = updated.rows[0];
    res.json({
      id: u.id,
      status: u.status,
      resolutionNote: u.resolution_note,
      resolvedAt: u.resolved_at,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    sendServerError(res, 'PATCH /admin/moderation/:id', err);
  } finally {
    client.release();
  }
});

// ── Users ────────────────────────────────────────────────────────────────────

router.get('/users/summary', async (_req, res) => {
  try {
    const [accountsResult, guestsResult] = await Promise.all([
      db.query(`
        SELECT
          COUNT(*)::int AS total_users,
          COUNT(*) FILTER (WHERE last_active_at > now() - interval '30 days')::int AS active_30d,
          COUNT(*) FILTER (
            WHERE subscription_tier = 'free' AND last_active_at > now() - interval '30 days'
          )::int AS free_active_30d,
          COUNT(*) FILTER (
            WHERE subscription_tier = 'supporter' AND subscription_interval IN ('monthly', 'annual')
          )::int AS paid_subscribers,
          COUNT(*) FILTER (
            WHERE subscription_tier = 'supporter' AND subscription_interval = 'lifetime'
          )::int AS lifetime,
          COUNT(*) FILTER (WHERE subscription_tier = 'supporter')::int AS supporters,
          COUNT(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS new_signups_7d,
          COUNT(*) FILTER (WHERE created_at > now() - interval '30 days')::int AS new_signups_30d,
          COUNT(*) FILTER (
            WHERE subscription_cancelled_at > now() - interval '30 days'
              AND subscription_cancelled_at <= now()
          )::int AS churned_30d,
          COUNT(*) FILTER (
            WHERE created_at > now() - interval '30 days'
              AND subscription_tier = 'supporter' AND subscription_interval IS NOT NULL
          )::int AS upgraded_30d
        FROM accounts
      `),
      db.query(`
        SELECT COUNT(DISTINCT session_id)::int AS n
        FROM usage_events
        WHERE user_id IS NULL AND created_at > now() - interval '7 days'
      `),
    ]);
    const a = accountsResult.rows[0];
    res.json({
      totalUsers: a.total_users,
      active30d: a.active_30d,
      freeActive30d: a.free_active_30d,
      paidSubscribers: a.paid_subscribers,
      lifetime: a.lifetime,
      supporters: a.supporters,
      newSignups7d: a.new_signups_7d,
      newSignups30d: a.new_signups_30d,
      churned30d: a.churned_30d,
      upgradeRate30d: a.new_signups_30d === 0 ? null : a.upgraded_30d / a.new_signups_30d,
      activeGuestSessions7d: guestsResult.rows[0].n,
    });
  } catch (err) {
    sendServerError(res, 'GET /admin/users/summary', err);
  }
});

// Fixed SQL fragments per range — the query-string value only selects a key.
const LOCAL_NOW = `(now() AT TIME ZONE '${TZ}')`;
const LOCAL_CREATED = `(created_at AT TIME ZONE '${TZ}')`;

const CHART_RANGES: Record<
  string,
  { unit: 'day' | 'week'; start: string; end: string; monthStart: string }
> = {
  '30d': {
    unit: 'day',
    start: `(${LOCAL_NOW}::date - 29)::timestamp`,
    end: `${LOCAL_NOW}::date::timestamp`,
    monthStart: `date_trunc('month', (${LOCAL_NOW}::date - 29)::timestamp)`,
  },
  '90d': {
    unit: 'day',
    start: `(${LOCAL_NOW}::date - 89)::timestamp`,
    end: `${LOCAL_NOW}::date::timestamp`,
    monthStart: `date_trunc('month', (${LOCAL_NOW}::date - 89)::timestamp)`,
  },
  all: {
    unit: 'week',
    start: `(SELECT date_trunc('week', MIN(${LOCAL_CREATED})) FROM accounts)`,
    end: `date_trunc('week', ${LOCAL_NOW})`,
    monthStart: `(SELECT date_trunc('month', MIN(${LOCAL_CREATED})) FROM accounts)`,
  },
};

router.get('/users/charts', async (req, res) => {
  try {
    const rawRange = queryString(req.query.range);
    const range = rawRange !== undefined && lookup(CHART_RANGES, rawRange) ? rawRange : '30d';
    const cfg = CHART_RANGES[range];

    const [growthResult, tierResult] = await Promise.all([
      db.query(`
        WITH series AS (
          SELECT generate_series(${cfg.start}, ${cfg.end}, interval '1 ${cfg.unit}') AS bucket
        ),
        per_bucket AS (
          SELECT date_trunc('${cfg.unit}', ${LOCAL_CREATED}) AS bucket, COUNT(*)::int AS n
          FROM accounts
          GROUP BY 1
        ),
        before_series AS (
          SELECT COUNT(*)::int AS n
          FROM accounts
          WHERE ${LOCAL_CREATED} < (SELECT MIN(bucket) FROM series)
        )
        SELECT to_char(s.bucket, 'YYYY-MM-DD') AS bucket,
               ((SELECT n FROM before_series)
                 + SUM(COALESCE(p.n, 0)) OVER (ORDER BY s.bucket))::int AS total_users
        FROM series s
        LEFT JOIN per_bucket p ON p.bucket = s.bucket
        ORDER BY s.bucket
      `),
      db.query(`
        WITH months AS (
          SELECT generate_series(${cfg.monthStart}, date_trunc('month', ${LOCAL_NOW}), interval '1 month')
                 AS month
        ),
        cohorts AS (
          SELECT date_trunc('month', ${LOCAL_CREATED}) AS month,
                 COUNT(*) FILTER (WHERE subscription_tier = 'free')::int AS free,
                 COUNT(*) FILTER (
                   WHERE subscription_tier = 'supporter' AND subscription_interval IN ('monthly', 'annual')
                 )::int AS paid,
                 COUNT(*) FILTER (
                   WHERE subscription_tier = 'supporter' AND subscription_interval = 'lifetime'
                 )::int AS lifetime,
                 COUNT(*) FILTER (
                   WHERE subscription_tier = 'supporter' AND subscription_interval IS NULL
                 )::int AS comped
          FROM accounts
          GROUP BY 1
        )
        SELECT to_char(m.month, 'YYYY-MM-DD') AS month,
               COALESCE(c.free, 0) AS free, COALESCE(c.paid, 0) AS paid,
               COALESCE(c.lifetime, 0) AS lifetime, COALESCE(c.comped, 0) AS comped
        FROM months m
        LEFT JOIN cohorts c ON c.month = m.month
        ORDER BY m.month
      `),
    ]);

    res.json({
      range,
      userGrowth: growthResult.rows.map((r) => ({ bucket: r.bucket, totalUsers: r.total_users })),
      tierBySignupMonth: tierResult.rows.map((r) => ({
        month: r.month,
        free: r.free,
        paid: r.paid,
        lifetime: r.lifetime,
        comped: r.comped,
      })),
    });
  } catch (err) {
    sendServerError(res, 'GET /admin/users/charts', err);
  }
});

// ── Features ─────────────────────────────────────────────────────────────────

router.get('/features', async (_req, res) => {
  try {
    const mfFlagCounts = MICRO_FEEDBACK_TRIGGERS.map(
      (t) => `COUNT(*) FILTER (WHERE ${t.flag})::int AS ${t.flag}`,
    ).join(',\n');

    const [activeResult, eventsResult, headlineResult, mfFlagsResult, mfResponsesResult] =
      await Promise.all([
        db.query(
          `SELECT COUNT(*)::int AS n FROM accounts WHERE last_active_at > now() - interval '30 days'`,
        ),
        db.query(`
          SELECT event_key, COUNT(*)::int AS uses, COUNT(DISTINCT user_id)::int AS users
          FROM usage_events
          WHERE created_at > now() - interval '30 days'
          GROUP BY event_key
        `),
        db.query(`
          SELECT
            (SELECT COUNT(DISTINCT session_id)::int FROM usage_events
              WHERE event_key LIKE 'canvas\\_%' AND created_at > now() - interval '30 days')
              AS canvas_sessions,
            (SELECT COUNT(*)::int FROM harvest_entries
              WHERE created_at > now() - interval '30 days') AS harvest_entries,
            (SELECT COUNT(*)::int FROM sowing_events
              WHERE created_at > now() - interval '30 days') AS planting_guide_entries
        `),
        // Flag column names come from the MICRO_FEEDBACK_TRIGGERS constant.
        db.query(`SELECT ${mfFlagCounts} FROM accounts`),
        db.query(`
          SELECT trigger_key, COUNT(*)::int AS n
          FROM micro_feedback_responses
          GROUP BY trigger_key
        `),
      ]);

    const activeUsers30d: number = activeResult.rows[0].n;
    const byKey = new Map<string, { uses: number; users: number }>(
      eventsResult.rows.map((r) => [r.event_key, { uses: r.uses, users: r.users }]),
    );

    const features = EVENT_KEYS.map((e) => {
      const stats = byKey.get(e.key) ?? { uses: 0, users: 0 };
      return {
        key: e.key,
        label: e.label,
        tier: e.tier,
        uses: stats.uses,
        users: stats.users,
        pctOfActive: activeUsers30d === 0 ? 0 : Math.round((stats.users / activeUsers30d) * 100),
      };
    }).sort((a, b) => b.pctOfActive - a.pctOfActive || a.label.localeCompare(b.label));

    const h = headlineResult.rows[0];
    const flags = mfFlagsResult.rows[0];
    const responsesByTrigger = new Map<string, number>(
      mfResponsesResult.rows.map((r) => [r.trigger_key, r.n]),
    );

    const microFeedback = MICRO_FEEDBACK_TRIGGERS.map((t) => {
      const timesFired: number = flags[t.flag];
      const responses = responsesByTrigger.get(t.triggerKey) ?? 0;
      return {
        triggerKey: t.triggerKey,
        label: t.label,
        timesFired,
        responses,
        responseRate: timesFired === 0 ? null : responses / timesFired,
      };
    });

    res.json({
      activeUsers30d,
      headline: {
        canvasSessions: h.canvas_sessions,
        harvestEntries: h.harvest_entries,
        plantingGuideEntries: h.planting_guide_entries,
      },
      features,
      microFeedback,
    });
  } catch (err) {
    sendServerError(res, 'GET /admin/features', err);
  }
});

// ── Feedback ─────────────────────────────────────────────────────────────────

const FEEDBACK_STATUS_FILTERS: Record<string, string | null> = {
  active: `f.status IN ('new', 'reviewed')`,
  new: `f.status = 'new'`,
  reviewed: `f.status = 'reviewed'`,
  closed: `f.status = 'closed'`,
  everything: null,
};
const FEEDBACK_CATEGORIES = ['bug', 'feature_request', 'general', 'data_quality'];
const FEEDBACK_TARGET_STATUSES = ['reviewed', 'closed'];

// Allowed status transitions (from → to). Same-status is a no-op handled
// separately.
const FEEDBACK_TRANSITIONS: Record<string, string[]> = {
  new: ['reviewed', 'closed'],
  reviewed: ['closed'],
  closed: ['reviewed'],
};

router.get('/feedback', async (req, res) => {
  const status = queryString(req.query.status) ?? 'active';
  if (lookup(FEEDBACK_STATUS_FILTERS, status) === undefined) {
    res.status(400).json({ error: 'Invalid status' });
    return;
  }
  const category = queryString(req.query.category);
  if (req.query.category !== undefined && (!category || !FEEDBACK_CATEGORIES.includes(category))) {
    res.status(400).json({ error: 'Invalid category' });
    return;
  }
  const surface = queryString(req.query.surface);
  const page = parsePage(req.query.page);

  try {
    const where: string[] = [];
    const params: unknown[] = [];
    const statusFilter = FEEDBACK_STATUS_FILTERS[status];
    if (statusFilter) where.push(statusFilter);
    if (category) {
      params.push(category);
      where.push(`f.category = $${params.length}`);
    }
    if (surface) {
      params.push(surface);
      where.push(`f.source_surface = $${params.length}`);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const [dataResult, totalResult, countsResult, surfacesResult] = await Promise.all([
      db.query(
        `SELECT f.id, f.category, LEFT(f.message, 120) AS preview, f.source_surface,
                f.app_version, f.status, f.created_at,
                COALESCE(NULLIF(TRIM(a.display_name), ''), a.email) AS user_label
         FROM feedback_submissions f
         LEFT JOIN accounts a ON a.id = f.user_id
         ${whereSql}
         ORDER BY (f.status = 'new') DESC, f.created_at DESC, f.id DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, PAGE_SIZE, (page - 1) * PAGE_SIZE],
      ),
      db.query(`SELECT COUNT(*)::int AS total FROM feedback_submissions f ${whereSql}`, params),
      db.query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'new')::int      AS new_count,
          COUNT(*) FILTER (WHERE status = 'reviewed')::int AS reviewed_count,
          COUNT(*) FILTER (WHERE status = 'closed')::int   AS closed_count
        FROM feedback_submissions
      `),
      db.query(`
        SELECT DISTINCT source_surface FROM feedback_submissions
        WHERE source_surface IS NOT NULL
        ORDER BY source_surface
      `),
    ]);

    res.json({
      data: dataResult.rows.map((r) => ({
        id: r.id,
        category: r.category,
        preview: r.preview,
        sourceSurface: r.source_surface,
        appVersion: r.app_version,
        status: r.status,
        createdAt: r.created_at,
        userLabel: r.user_label,
      })),
      page,
      total: totalResult.rows[0].total,
      counts: {
        new: countsResult.rows[0].new_count,
        reviewed: countsResult.rows[0].reviewed_count,
        closed: countsResult.rows[0].closed_count,
      },
      surfaces: surfacesResult.rows.map((r) => r.source_surface),
    });
  } catch (err) {
    sendServerError(res, 'GET /admin/feedback', err);
  }
});

router.get('/feedback/:id', async (req, res) => {
  const id = parseIdParam(req.params.id);
  if (id === null) return sendInvalidId(res);

  try {
    const result = await db.query(
      `SELECT f.id, f.user_id, f.category, f.message, f.source_surface, f.app_version,
              f.status, f.created_at, f.updated_at,
              a.id AS a_id, a.display_name AS a_display_name, a.email AS a_email
       FROM feedback_submissions f
       LEFT JOIN accounts a ON a.id = f.user_id
       WHERE f.id = $1`,
      [id],
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const r = result.rows[0];
    res.json({
      id: r.id,
      userId: r.user_id,
      category: r.category,
      message: r.message,
      sourceSurface: r.source_surface,
      appVersion: r.app_version,
      status: r.status,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      user: r.a_id === null ? null : { id: r.a_id, displayName: r.a_display_name, email: r.a_email },
    });
  } catch (err) {
    sendServerError(res, 'GET /admin/feedback/:id', err);
  }
});

// Registered before PATCH /feedback/:id so 'bulk' isn't taken as an id.
router.patch('/feedback/bulk', async (req, res) => {
  const { ids, status } = (req.body ?? {}) as { ids?: unknown; status?: unknown };
  if (
    !Array.isArray(ids) ||
    ids.length < 1 ||
    ids.length > 100 ||
    !ids.every((v) => Number.isInteger(v) && v >= 1 && v <= PG_INT_MAX)
  ) {
    res.status(400).json({ error: 'ids must be an array of 1 to 100 positive integers' });
    return;
  }
  if (typeof status !== 'string' || !FEEDBACK_TARGET_STATUSES.includes(status)) {
    res.status(400).json({ error: 'status must be one of: reviewed, closed' });
    return;
  }

  try {
    const result = await db.query<{ id: number }>(
      `UPDATE feedback_submissions SET status = $1, updated_at = NOW()
       WHERE id = ANY($2::int[]) RETURNING id`,
      [status, ids],
    );
    res.json({ updated: result.rows.map((r) => r.id).sort((a, b) => a - b) });
  } catch (err) {
    sendServerError(res, 'PATCH /admin/feedback/bulk', err);
  }
});

router.patch('/feedback/:id', async (req, res) => {
  const id = parseIdParam(req.params.id);
  if (id === null) return sendInvalidId(res);

  const { status } = (req.body ?? {}) as { status?: unknown };
  if (typeof status !== 'string' || !FEEDBACK_TARGET_STATUSES.includes(status)) {
    res.status(400).json({ error: 'status must be one of: reviewed, closed' });
    return;
  }

  try {
    const existing = await db.query<{ status: string; updated_at: Date }>(
      'SELECT status, updated_at FROM feedback_submissions WHERE id = $1',
      [id],
    );
    if (existing.rows.length === 0) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const current = existing.rows[0];
    if (current.status === status) {
      res.json({ id, status, updatedAt: current.updated_at });
      return;
    }
    if (!lookup(FEEDBACK_TRANSITIONS, current.status)?.includes(status)) {
      res.status(409).json({ error: `Cannot change status from ${current.status} to ${status}.` });
      return;
    }

    const result = await db.query<{ id: number; status: string; updated_at: Date }>(
      `UPDATE feedback_submissions SET status = $1, updated_at = NOW()
       WHERE id = $2 RETURNING id, status, updated_at`,
      [status, id],
    );
    const u = result.rows[0];
    res.json({ id: u.id, status: u.status, updatedAt: u.updated_at });
  } catch (err) {
    sendServerError(res, 'PATCH /admin/feedback/:id', err);
  }
});

// ── System ───────────────────────────────────────────────────────────────────

const EXPECTED_JOBS = [{ key: 'nightly', label: 'Nightly maintenance', maxAgeHours: 26 }];

const DEGRADED_MIN_REQUESTS = 50;
const DEGRADED_ERROR_RATE = 0.02;
const DEGRADED_P95_MS = 2000;

router.get('/system', async (_req, res) => {
  const requestMetrics = getRequestMetrics();
  const sentry = {
    issuesUrl: process.env.ADMIN_SENTRY_ISSUES_URL || null,
    performanceUrl: process.env.ADMIN_SENTRY_PERFORMANCE_URL || null,
  };

  const dbStart = process.hrtime.bigint();
  try {
    await db.query('SELECT 1');
  } catch (err) {
    logger.error('GET /admin/system database check failed', err);
    res.json({
      status: 'outage',
      database: { ok: false, latencyMs: null },
      jobs: [],
      requestMetrics,
      sentry,
    });
    return;
  }
  const latencyMs = Math.round((Number(process.hrtime.bigint() - dbStart) / 1e6) * 100) / 100;

  try {
    const [lastRunResult, lastOkResult] = await Promise.all([
      db.query<{ job_key: string; status: string; started_at: Date; error_msg: string | null }>(`
        SELECT DISTINCT ON (job_key) job_key, status, started_at, error_msg
        FROM job_runs
        ORDER BY job_key, started_at DESC, id DESC
      `),
      db.query<{ job_key: string; last_ok_at: Date | null }>(`
        SELECT job_key, MAX(started_at) FILTER (WHERE status = 'ok') AS last_ok_at
        FROM job_runs
        GROUP BY job_key
      `),
    ]);

    const lastRunByKey = new Map(lastRunResult.rows.map((r) => [r.job_key, r]));
    const lastOkByKey = new Map(lastOkResult.rows.map((r) => [r.job_key, r.last_ok_at]));
    const expectedByKey = new Map(EXPECTED_JOBS.map((j) => [j.key, j]));
    const unexpectedKeys = [...lastRunByKey.keys()].filter((k) => !expectedByKey.has(k)).sort();
    const jobKeys = [...EXPECTED_JOBS.map((j) => j.key), ...unexpectedKeys];

    const now = Date.now();
    const jobs = jobKeys.map((jobKey) => {
      const expected = expectedByKey.get(jobKey);
      const lastRun = lastRunByKey.get(jobKey);
      const lastOkAt = lastOkByKey.get(jobKey) ?? null;

      let state: 'never' | 'failed' | 'stale' | 'ok';
      if (!lastRun) state = 'never';
      else if (lastRun.status === 'failed') state = 'failed';
      else if (
        expected &&
        (!lastOkAt || now - lastOkAt.getTime() > expected.maxAgeHours * 60 * 60 * 1000)
      )
        state = 'stale';
      else state = 'ok';

      return {
        jobKey,
        label: expected?.label ?? jobKey,
        state,
        lastRunAt: lastRun?.started_at ?? null,
        lastStatus: lastRun?.status ?? null,
        lastOkAt,
        errorMsg: lastRun?.error_msg ?? null,
      };
    });

    const lfh = requestMetrics.lastFullHour;
    const requestsDegraded =
      lfh !== null &&
      lfh.count >= DEGRADED_MIN_REQUESTS &&
      (lfh.errorRate > DEGRADED_ERROR_RATE || (lfh.p95Ms ?? 0) > DEGRADED_P95_MS);
    const jobsDegraded = jobs.some((j) => j.state === 'failed' || j.state === 'stale');

    res.json({
      status: jobsDegraded || requestsDegraded ? 'degraded' : 'operational',
      database: { ok: true, latencyMs },
      jobs,
      requestMetrics,
      sentry,
    });
  } catch (err) {
    sendServerError(res, 'GET /admin/system', err);
  }
});

export default router;

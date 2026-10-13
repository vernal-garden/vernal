import { Router, Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { db } from '../lib/db';
import { requireAuth, requireSession } from '../middleware/auth';
import { writeLimiter } from '../middleware/rateLimiters';
import { isNumericId } from '../lib/validation';
import { estimateFrostDates } from '../lib/frostDates';
import {
  applySeasonYear,
  computeWindows,
  currentSeason,
  isIsoDate,
  normalizeFrostTolerance,
  type FrostContext,
  type Overrides,
} from '../lib/plantingSchedule';
import { logger } from '../lib/logger';
import type { SessionData } from '../types';

const router = Router();
router.use(requireSession);

// ── Types ─────────────────────────────────────────────────────────────────────

interface GardenRow {
  id: string;
  name: string;
  zone: string;
  zone_location_label: string | null;
}

interface GuideRow {
  garden_id: string;
  seed_id: string | null;
  cambium_seed_id: string | null;
  planting_count: number;
  common_name: string | null;
  scientific_name: string | null;
  plant_family: string | null;
  weeks_to_transplant: number | null;
  frost_tolerance: string | null;
  maturity_days_min: number | null;
  maturity_days_max: number | null;
  succession_interval_weeks: number | null;
}

interface PreferenceRow {
  id: string;
  garden_id: string;
  seed_id: string | null;
  cambium_seed_id: string | null;
  indoor_start: string | null;
  transplant: string | null;
  direct_sow: string | null;
}

interface SowingEventRow {
  id: string;
  garden_id: string;
  seed_id: string | null;
  cambium_seed_id: string | null;
  marked_done_at: Date | null;
}

// A planting, preference or sowing event is keyed by its personal seed when it
// has one, otherwise by its Cambium seed.
type SeedKey = { kind: 'seed'; id: number } | { kind: 'cambium'; id: number };

function rowKey(gardenId: string, seedId: string | null, cambiumSeedId: string | null): string {
  return seedId !== null ? `${gardenId}:seed:${seedId}` : `${gardenId}:cambium:${cambiumSeedId}`;
}

function seedKeyString(key: SeedKey): string {
  return `${key.kind}:${key.id}`;
}

// SQL predicate matching a SeedKey against seed_id / cambium_seed_id columns.
// `param` is the placeholder holding key.id.
function seedKeyWhere(key: SeedKey, param: string): string {
  return key.kind === 'seed'
    ? `seed_id = ${param}`
    : `seed_id IS NULL AND cambium_seed_id = ${param}`;
}

// ── Validation helpers ────────────────────────────────────────────────────────

function parseSeason(v: unknown): number | null {
  const n = typeof v === 'string' && /^\d+$/.test(v) ? parseInt(v, 10) : v;
  if (!Number.isInteger(n) || (n as number) < 2000 || (n as number) > 2100) return null;
  return n as number;
}

function parsePositiveInt(v: unknown): number | null {
  const n = typeof v === 'string' && isNumericId(v) ? parseInt(v, 10) : v;
  if (!Number.isInteger(n) || (n as number) <= 0) return null;
  return n as number;
}

function parseSeedKey(body: Record<string, unknown>): SeedKey | { error: string } {
  const hasSeedId = body.seedId !== undefined && body.seedId !== null;
  const hasCambiumSeedId = body.cambiumSeedId !== undefined && body.cambiumSeedId !== null;
  if (hasSeedId === hasCambiumSeedId) {
    return { error: 'provide exactly one of seedId or cambiumSeedId' };
  }
  if (hasSeedId) {
    const id = parsePositiveInt(body.seedId);
    return id === null ? { error: 'seedId must be a positive integer' } : { kind: 'seed', id };
  }
  const id = parsePositiveInt(body.cambiumSeedId);
  return id === null
    ? { error: 'cambiumSeedId must be a positive integer' }
    : { kind: 'cambium', id };
}

function bodyOf(req: Request): Record<string, unknown> | null {
  const body: unknown = req.body;
  return body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

async function ownGarden(gardenId: number, session: SessionData): Promise<boolean> {
  const { rows } = await db.query(
    'SELECT id FROM gardens WHERE id = $1 AND (owner_id = $2 OR guest_session_id = $3)',
    [gardenId, session.account?.id ?? null, session.id],
  );
  return rows.length > 0;
}

// Personal seeds must belong to the session; Cambium seeds must exist.
async function seedExists(key: SeedKey, session: SessionData): Promise<boolean> {
  const { rows } =
    key.kind === 'seed'
      ? await db.query(
          'SELECT id FROM seeds WHERE id = $1 AND (owner_id = $2 OR guest_session_id = $3)',
          [key.id, session.account?.id ?? null, session.id],
        )
      : await db.query('SELECT id FROM cambium.seeds WHERE id = $1', [key.id]);
  return rows.length > 0;
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // connection already broken — release() below discards it
  }
}

// ── GET /api/planting-guide ───────────────────────────────────────────────────

router.get('/', async (req: Request, res: Response) => {
  const session = req.session as SessionData;
  const accountId = session.account?.id ?? null;
  const nowSeason = currentSeason(new Date());

  let season = nowSeason;
  if (req.query.season !== undefined) {
    const parsed = parseSeason(req.query.season);
    if (parsed === null) {
      return res.status(400).json({ error: 'season must be an integer between 2000 and 2100' });
    }
    season = parsed;
  }

  let gardenId: number | null = null;
  if (req.query.gardenId !== undefined) {
    if (!isNumericId(req.query.gardenId)) {
      return res.status(400).json({ error: 'gardenId must be numeric' });
    }
    gardenId = parseInt(req.query.gardenId, 10);
  }

  try {
    const { rows: gardens } = await db.query<GardenRow>(
      `SELECT id::text, name, zone, zone_location_label FROM gardens
       WHERE (owner_id = $1 OR guest_session_id = $2)
         AND ($3::int IS NULL OR id = $3)
       ORDER BY id`,
      [accountId, session.id, gardenId],
    );
    if (gardenId !== null && gardens.length === 0) {
      return res.status(404).json({ error: 'Garden not found' });
    }

    let accountFrost: { last: string | null; first: string | null } | null = null;
    if (accountId !== null) {
      const { rows } = await db.query<{ last: string | null; first: string | null }>(
        `SELECT to_char(last_spring_frost_date, 'YYYY-MM-DD') AS last,
                to_char(first_fall_frost_date,  'YYYY-MM-DD') AS first
         FROM accounts WHERE id = $1`,
        [accountId],
      );
      if (rows[0]?.last) accountFrost = rows[0];
    }

    const frostByGarden = new Map<string, FrostContext & { firstFallFrost: string | null }>();
    for (const g of gardens) {
      if (accountFrost) {
        frostByGarden.set(g.id, {
          lastSpringFrost: applySeasonYear(accountFrost.last as string, season),
          firstFallFrost: accountFrost.first ? applySeasonYear(accountFrost.first, season) : null,
          frostSource: 'account_frost',
          frostFree: false,
        });
      } else {
        const est = estimateFrostDates(g.zone, season);
        frostByGarden.set(g.id, {
          lastSpringFrost: est.lastSpringFrost,
          firstFallFrost: est.firstFallFrost,
          frostSource: est.parsed && !est.frostFree ? 'zone_estimate' : null,
          frostFree: est.frostFree,
        });
      }
    }

    const gardenIds = gardens.map((g) => Number(g.id));

    const { rows } = await db.query<GuideRow>(
      `SELECT p.garden_id::text, p.seed_id::text, p.cambium_seed_id::text,
              SUM(p.quantity)::int AS planting_count,
              CASE WHEN p.seed_id IS NOT NULL THEN s.common_name ELSE cs.common_name END AS common_name,
              CASE WHEN p.seed_id IS NOT NULL THEN s.scientific_name ELSE cs.scientific_name END AS scientific_name,
              CASE WHEN p.seed_id IS NOT NULL THEN s.plant_family ELSE cs.plant_family END AS plant_family,
              CASE WHEN p.seed_id IS NOT NULL THEN s.weeks_to_transplant ELSE cs.weeks_to_transplant END AS weeks_to_transplant,
              CASE WHEN p.seed_id IS NOT NULL THEN s.frost_tolerance ELSE cs.frost_tolerance END AS frost_tolerance,
              CASE WHEN p.seed_id IS NOT NULL THEN s.maturity_days_min ELSE cs.maturity_days_min END AS maturity_days_min,
              CASE WHEN p.seed_id IS NOT NULL THEN s.maturity_days_max ELSE cs.maturity_days_max END AS maturity_days_max,
              CASE WHEN p.seed_id IS NOT NULL THEN s.succession_interval_weeks ELSE cs.succession_interval_weeks END AS succession_interval_weeks
       FROM plantings p
       LEFT JOIN seeds s          ON s.id  = p.seed_id
       LEFT JOIN cambium.seeds cs ON cs.id = p.cambium_seed_id
       WHERE p.garden_id = ANY($1::int[]) AND p.season = $2
       GROUP BY p.garden_id, p.seed_id, p.cambium_seed_id, s.id, cs.id
       ORDER BY common_name, p.garden_id`,
      [gardenIds, season],
    );

    const preferences = new Map<string, Overrides>();
    if (accountId !== null) {
      const { rows: prefRows } = await db.query<PreferenceRow>(
        `SELECT id::text, garden_id::text, seed_id::text, cambium_seed_id::text,
                to_char(custom_indoor_start_date, 'YYYY-MM-DD') AS indoor_start,
                to_char(custom_transplant_date,   'YYYY-MM-DD') AS transplant,
                to_char(custom_direct_sow_date,   'YYYY-MM-DD') AS direct_sow
         FROM user_seed_preferences
         WHERE account_id = $1 AND garden_id = ANY($2::int[])
         ORDER BY id`,
        [accountId, gardenIds],
      );
      for (const p of prefRows) {
        const key = rowKey(p.garden_id, p.seed_id, p.cambium_seed_id);
        if (!preferences.has(key)) {
          preferences.set(key, {
            indoorStart: p.indoor_start,
            transplant: p.transplant,
            directSow: p.direct_sow,
          });
        }
      }
    }

    const sowingEvents = new Map<string, SowingEventRow>();
    const { rows: eventRows } = await db.query<SowingEventRow>(
      `SELECT id::text, garden_id::text, seed_id::text, cambium_seed_id::text, marked_done_at
       FROM sowing_events
       WHERE garden_id = ANY($1::int[]) AND season = $2
       ORDER BY id`,
      [gardenIds, season],
    );
    for (const e of eventRows) {
      const key = rowKey(e.garden_id, e.seed_id, e.cambium_seed_id);
      if (!sowingEvents.has(key)) sowingEvents.set(key, e);
    }

    const NO_OVERRIDES: Overrides = { indoorStart: null, transplant: null, directSow: null };

    return res.json({
      season,
      currentSeason: nowSeason,
      readOnly: season < nowSeason,
      gardens: gardens.map((g) => {
        const frost = frostByGarden.get(g.id)!;
        return {
          id: g.id,
          name: g.name,
          zone: g.zone,
          zoneLocationLabel: g.zone_location_label,
          frost: {
            lastSpringFrost: frost.lastSpringFrost,
            firstFallFrost: frost.firstFallFrost,
            frostSource: frost.frostSource,
            frostFree: frost.frostFree,
          },
        };
      }),
      rows: rows.map((r) => {
        const key = rowKey(r.garden_id, r.seed_id, r.cambium_seed_id);
        const overrides = preferences.get(key) ?? null;
        const event = sowingEvents.get(key) ?? null;
        const { missingReason, ...windows } = computeWindows(
          {
            weeksToTransplant: r.weeks_to_transplant,
            frostTolerance: r.frost_tolerance,
            maturityDaysMin: r.maturity_days_min,
            maturityDaysMax: r.maturity_days_max,
          },
          overrides ?? NO_OVERRIDES,
          frostByGarden.get(r.garden_id)!,
          season,
        );
        return {
          gardenId: r.garden_id,
          seedId: r.seed_id,
          cambiumSeedId: r.cambium_seed_id,
          commonName: r.common_name,
          scientificName: r.scientific_name,
          plantFamily: r.plant_family,
          plantingCount: r.planting_count,
          successionIntervalWeeks: r.succession_interval_weeks,
          frostTolerance: normalizeFrostTolerance(r.frost_tolerance),
          weeksToTransplant: r.weeks_to_transplant,
          maturityDaysMin: r.maturity_days_min,
          maturityDaysMax: r.maturity_days_max,
          overrides,
          done: event ? { sowingEventId: event.id, markedDoneAt: event.marked_done_at } : null,
          windows,
          missingReason,
        };
      }),
    });
  } catch (err) {
    logger.error('GET /api/planting-guide failed', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── PUT /api/planting-guide/overrides ─────────────────────────────────────────

const OVERRIDE_FIELDS = [
  ['indoorStart', 'custom_indoor_start_date'],
  ['transplant', 'custom_transplant_date'],
  ['directSow', 'custom_direct_sow_date'],
] as const;

router.put('/overrides', requireAuth, writeLimiter, async (req: Request, res: Response) => {
  const session = req.session as SessionData;
  const accountId = session.account!.id;
  const body = bodyOf(req);
  if (!body) return res.status(400).json({ error: 'body must be a JSON object' });

  const gardenId = parsePositiveInt(body.gardenId);
  if (gardenId === null) return res.status(400).json({ error: 'gardenId must be a positive integer' });

  const seedKey = parseSeedKey(body);
  if ('error' in seedKey) return res.status(400).json({ error: seedKey.error });

  // undefined = leave unchanged; null = clear; otherwise a YYYY-MM-DD date.
  const provided: Partial<Overrides> = {};
  for (const [field] of OVERRIDE_FIELDS) {
    const v = body[field];
    if (v === undefined) continue;
    if (v !== null && !isIsoDate(v)) {
      return res.status(400).json({ error: `${field} must be a YYYY-MM-DD date or null` });
    }
    provided[field] = v;
  }

  let client: PoolClient | null = null;
  try {
    if (!(await ownGarden(gardenId, session))) {
      return res.status(404).json({ error: 'Garden not found' });
    }
    if (!(await seedExists(seedKey, session))) {
      return res.status(400).json({ error: 'seed not found' });
    }

    client = await db.connect();
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `usp:${accountId}:${gardenId}:${seedKeyString(seedKey)}`,
    ]);

    const { rows: existing } = await client.query<PreferenceRow>(
      `SELECT id::text, garden_id::text, seed_id::text, cambium_seed_id::text,
              to_char(custom_indoor_start_date, 'YYYY-MM-DD') AS indoor_start,
              to_char(custom_transplant_date,   'YYYY-MM-DD') AS transplant,
              to_char(custom_direct_sow_date,   'YYYY-MM-DD') AS direct_sow
       FROM user_seed_preferences
       WHERE account_id = $1 AND garden_id = $2 AND ${seedKeyWhere(seedKey, '$3')}
       ORDER BY id LIMIT 1`,
      [accountId, gardenId, seedKey.id],
    );
    const row = existing[0] ?? null;

    const merged: Overrides = {
      indoorStart: 'indoorStart' in provided ? provided.indoorStart! : (row?.indoor_start ?? null),
      transplant: 'transplant' in provided ? provided.transplant! : (row?.transplant ?? null),
      directSow: 'directSow' in provided ? provided.directSow! : (row?.direct_sow ?? null),
    };
    const allNull =
      merged.indoorStart === null && merged.transplant === null && merged.directSow === null;

    if (allNull) {
      if (row) await client.query('DELETE FROM user_seed_preferences WHERE id = $1', [row.id]);
    } else if (row) {
      await client.query(
        `UPDATE user_seed_preferences
         SET custom_indoor_start_date = $2, custom_transplant_date = $3,
             custom_direct_sow_date = $4, updated_at = now()
         WHERE id = $1`,
        [row.id, merged.indoorStart, merged.transplant, merged.directSow],
      );
    } else {
      await client.query(
        `INSERT INTO user_seed_preferences
           (account_id, seed_id, cambium_seed_id, garden_id,
            custom_indoor_start_date, custom_transplant_date, custom_direct_sow_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          accountId,
          seedKey.kind === 'seed' ? seedKey.id : null,
          seedKey.kind === 'cambium' ? seedKey.id : null,
          gardenId,
          merged.indoorStart,
          merged.transplant,
          merged.directSow,
        ],
      );
    }

    await client.query('COMMIT');
    return res.json({ overrides: allNull ? null : merged });
  } catch (err) {
    if (client) await rollback(client);
    logger.error('PUT /api/planting-guide/overrides failed', err);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    client?.release();
  }
});

// ── PUT /api/planting-guide/done ──────────────────────────────────────────────

router.put('/done', writeLimiter, async (req: Request, res: Response) => {
  const session = req.session as SessionData;
  const body = bodyOf(req);
  if (!body) return res.status(400).json({ error: 'body must be a JSON object' });

  const gardenId = parsePositiveInt(body.gardenId);
  if (gardenId === null) return res.status(400).json({ error: 'gardenId must be a positive integer' });

  const seedKey = parseSeedKey(body);
  if ('error' in seedKey) return res.status(400).json({ error: seedKey.error });

  if (typeof body.season !== 'number' || parseSeason(body.season) === null) {
    return res.status(400).json({ error: 'season must be an integer between 2000 and 2100' });
  }
  const season = body.season;

  if (typeof body.done !== 'boolean') {
    return res.status(400).json({ error: 'done must be a boolean' });
  }
  const done = body.done;

  let client: PoolClient | null = null;
  try {
    if (!(await ownGarden(gardenId, session))) {
      return res.status(404).json({ error: 'Garden not found' });
    }
    if (season < currentSeason(new Date())) {
      return res.status(409).json({ error: 'Past seasons are read-only.' });
    }
    if (!(await seedExists(seedKey, session))) {
      return res.status(400).json({ error: 'seed not found' });
    }

    client = await db.connect();
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `sow:${gardenId}:${seedKeyString(seedKey)}:${season}`,
    ]);

    const { rows: existing } = await client.query<{ id: string }>(
      `SELECT id::text FROM sowing_events
       WHERE garden_id = $1 AND ${seedKeyWhere(seedKey, '$2')} AND season = $3
       ORDER BY id LIMIT 1`,
      [gardenId, seedKey.id, season],
    );
    const eventId = existing[0]?.id ?? null;

    let result: { id: string; marked_done_at: Date | null } | null = null;
    if (done && eventId) {
      const { rows } = await client.query<{ id: string; marked_done_at: Date | null }>(
        `UPDATE sowing_events SET marked_done_at = now() WHERE id = $1
         RETURNING id::text, marked_done_at`,
        [eventId],
      );
      result = rows[0];
    } else if (done) {
      const { rows: plantingRows } = await client.query<{ id: number | null }>(
        `SELECT MIN(id) AS id FROM plantings
         WHERE garden_id = $1 AND ${seedKeyWhere(seedKey, '$2')} AND season = $3`,
        [gardenId, seedKey.id, season],
      );
      const { rows } = await client.query<{ id: string; marked_done_at: Date | null }>(
        `INSERT INTO sowing_events
           (planting_id, garden_id, seed_id, cambium_seed_id, season, marked_done_at)
         VALUES ($1, $2, $3, $4, $5, now())
         RETURNING id::text, marked_done_at`,
        [
          plantingRows[0]?.id ?? null,
          gardenId,
          seedKey.kind === 'seed' ? seedKey.id : null,
          seedKey.kind === 'cambium' ? seedKey.id : null,
          season,
        ],
      );
      result = rows[0];
    } else if (eventId) {
      // Undo keeps the row: harvest entries may already reference it.
      const { rows } = await client.query<{ id: string; marked_done_at: Date | null }>(
        `UPDATE sowing_events SET marked_done_at = NULL WHERE id = $1
         RETURNING id::text, marked_done_at`,
        [eventId],
      );
      result = rows[0];
    }

    await client.query('COMMIT');
    return res.json({
      sowingEventId: result?.id ?? null,
      markedDoneAt: result?.marked_done_at ?? null,
    });
  } catch (err) {
    if (client) await rollback(client);
    logger.error('PUT /api/planting-guide/done failed', err);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    client?.release();
  }
});

export default router;

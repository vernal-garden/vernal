import { Router } from 'express';
import type { PoolClient } from 'pg';
import { db } from '../lib/db';
import { logger } from '../lib/logger';
import { LIMITS, withinCap } from '../lib/limits';
import { requireSession } from '../middleware/auth';
import { writeLimiter } from '../middleware/rateLimiters';
import { isNumericId } from '../lib/validation';
import { currentSeason, todayPacific } from '../lib/season';
import { UI_MAX_QUANTITY } from '../lib/plantingQuantity';
import { lockSowingKey, syncSowingEvent, type SeedKey } from '../lib/sowingSync';
import { deriveGrowth } from '../jobs/nightly';
import { recomputeHarvestableCount } from '../lib/gardenBadges';
import { invalidateMetrics } from '../lib/metricsCache';
import type { SessionData } from '../types';

// ── Three routers, all with mergeParams ──────────────────────────────────────

export const plantingsNestedRouter = Router({ mergeParams: true });  // /api/gardens/:gardenId/beds/:bedId/plantings
export const gardenPlantingsRouter = Router({ mergeParams: true });  // /api/gardens/:gardenId/plantings
export const plantingsFlatRouter = Router({ mergeParams: true });    // /api/plantings

plantingsNestedRouter.use(requireSession);
gardenPlantingsRouter.use(requireSession);
plantingsFlatRouter.use(requireSession);

// ── Types ────────────────────────────────────────────────────────────────────

type StartMethod = 'sown' | 'transplanted';

interface PlantingRow {
  id: string;
  bed_id: string;
  garden_id: string;
  season: number;
  seed_id: string | null;
  cambium_seed_id: string | null;
  quantity: number;
  planting_date: string;
  start_method: StartMethod;
  cell_x: number | null;
  cell_y: number | null;
  point_x: string | null;
  point_y: string | null;
  growth_stage_pct: string | null;
  growth_stage: number | null;
  displayed_growth_stage: number | null;
  harvest_ready: boolean;
  harvest_window_end: string | null;
  indicator_dismissed_at: string | null;
  created_at: string;
  updated_at: string;
  companion_seed_id?: string | null;
  spacing_inches?: string | null;
  common_name?: string | null;
  illustration_key?: string | null;
}

interface BedInfo {
  id: string;
  season: number;
  type: 'grid' | 'freeform';
  grid_cols: number | null;
  grid_rows: number | null;
}

// What a POST's transaction did: placed (inserted or merged), refused with a
// response body, or found its merge target deleted underneath it.
type PlaceOutcome =
  | { kind: 'placed'; id: string; merged: boolean }
  | { kind: 'refused'; status: number; body: Record<string, unknown> }
  | { kind: 'vanished'; plantingId: string };

interface PatchPlantingRow extends PlantingRow {
  bed_type: 'grid' | 'freeform';
  grid_cols: number | null;
  grid_rows: number | null;
}

// planting_date is still nullable (a later release adds NOT NULL), and older
// code may write NULL; such a planting reads as dated the Pacific day it was
// created, as deriveGrowth and syncSowingEvent treat it.
const PLANTING_DATE_SQL =
  `COALESCE(p.planting_date, (p.created_at AT TIME ZONE 'America/Los_Angeles')::date)::text AS planting_date`;

// Extended SELECT for GET handlers — includes companion resolution via JOINs.
const PLANTING_GET_QUERY = `
  SELECT p.id::text, p.bed_id::text, p.garden_id::text, p.season,
    p.seed_id::text, p.cambium_seed_id::text,
    p.quantity, ${PLANTING_DATE_SQL}, p.start_method,
    p.cell_x, p.cell_y, p.point_x, p.point_y,
    p.growth_stage_pct, p.growth_stage, p.displayed_growth_stage,
    p.harvest_ready, p.harvest_window_end,
    p.indicator_dismissed_at, p.created_at, p.updated_at,
    COALESCE(p.cambium_seed_id, s.cambium_source_id)::text AS companion_seed_id,
    COALESCE(cs.spacing_inches, s.spacing_inches) AS spacing_inches,
    COALESCE(cs.common_name, s.common_name) AS common_name,
    COALESCE(cs.illustration_key, s.illustration_key) AS illustration_key
  FROM plantings p
  LEFT JOIN seeds s          ON s.id  = p.seed_id
  LEFT JOIN cambium.seeds cs ON cs.id = COALESCE(p.cambium_seed_id, s.cambium_source_id)
`;

const GROWTH_KEYS = [
  'growthStagePct', 'harvestReady', 'harvestWindowEnd',
  'stage', 'displayedStage', 'anchored',
];

// Upper bound on plantingIds per displayed-stage request.
const MAX_DISPLAYED_STAGE_IDS = 500;

// Freeform point coordinates stay within the canvas bounds beds use.
const MAX_COORD = 100000;

// ── Formatters ───────────────────────────────────────────────────────────────

function formatPlanting(row: PlantingRow) {
  return {
    id: row.id,
    bedId: row.bed_id,
    gardenId: row.garden_id,
    season: row.season,
    seedId: row.seed_id,
    cambiumSeedId: row.cambium_seed_id,
    quantity: row.quantity,
    plantingDate: row.planting_date,
    startMethod: row.start_method,
    cell: row.cell_x !== null ? { x: row.cell_x, y: row.cell_y } : null,
    point: row.point_x !== null ? { x: Number(row.point_x), y: Number(row.point_y) } : null,
    growth: {
      stagePct: row.growth_stage_pct !== null ? Number(row.growth_stage_pct) : null,
      stage: row.growth_stage,
      displayedStage: row.displayed_growth_stage,
      anchored: row.growth_stage !== null,
      harvestReady: row.harvest_ready,
      harvestWindowEnd: row.harvest_window_end,
      indicatorDismissedAt: row.indicator_dismissed_at,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    companionSeedId: row.companion_seed_id ?? null,
    spacingInches: row.spacing_inches != null ? Number(row.spacing_inches) : null,
    commonName: row.common_name ?? null,
    illustrationKey: row.illustration_key ?? null,
  };
}

// ── Shared helpers ────────────────────────────────────────────────────────────

interface OccupantRow {
  id: string;
  seed_id: string | null;
  cambium_seed_id: string | null;
  quantity: number;
  cambium_identity: string | null;
  common_name: string | null;
}

function cellOccupiedBody(occupant: { id: string; common_name?: string | null }) {
  return {
    error: 'cell occupied',
    code: 'CELL_OCCUPIED',
    occupant: { id: occupant.id, commonName: occupant.common_name ?? null },
  };
}

function isCellIndexViolation(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string };
  return e?.code === '23505' && e.constraint === 'plantings_one_per_cell_idx';
}

async function ownGarden(gardenId: string, session: SessionData): Promise<boolean> {
  const accountId = session.account?.id ?? null;
  const sessionId = session.id;
  const { rows } = await db.query(
    'SELECT id FROM gardens WHERE id = $1 AND (owner_id = $2 OR guest_session_id = $3)',
    [gardenId, accountId, sessionId],
  );
  return rows.length > 0;
}

async function bedInGarden(bedId: string, gardenId: string): Promise<BedInfo | null> {
  const { rows } = await db.query<BedInfo>(
    `SELECT id::text, season, type, grid_cols, grid_rows
     FROM beds WHERE id = $1 AND garden_id = $2`,
    [bedId, gardenId],
  );
  return rows[0] ?? null;
}

function validateCell(cell: unknown, bed: BedInfo): string | null {
  if (!cell || typeof cell !== 'object' || Array.isArray(cell)) {
    return 'cell must be an object with x and y';
  }
  const c = cell as Record<string, unknown>;
  if (!Number.isInteger(c.x) || !Number.isInteger(c.y)) {
    return 'cell.x and cell.y must be integers';
  }
  const x = c.x as number;
  const y = c.y as number;
  const cols = bed.grid_cols ?? 0;
  const rows = bed.grid_rows ?? 0;
  if (x < 0 || x >= cols) {
    return `cell.x must be between 0 and ${cols - 1}`;
  }
  if (y < 0 || y >= rows) {
    return `cell.y must be between 0 and ${rows - 1}`;
  }
  return null;
}

function validatePoint(point: unknown): string | null {
  if (!point || typeof point !== 'object' || Array.isArray(point)) {
    return 'point must be an object with x and y';
  }
  const p = point as Record<string, unknown>;
  if (typeof p.x !== 'number' || !Number.isFinite(p.x)) {
    return 'point.x must be a finite number';
  }
  if (typeof p.y !== 'number' || !Number.isFinite(p.y)) {
    return 'point.y must be a finite number';
  }
  // Same canvas bounds as bed geometry (validateGrid / validateFreeform).
  if (Math.abs(p.x) > MAX_COORD || Math.abs(p.y) > MAX_COORD) {
    return `point.x and point.y must be between -${MAX_COORD} and ${MAX_COORD}`;
  }
  return null;
}

function validateSeason(v: unknown): number | string {
  const n = typeof v === 'string' ? parseInt(v, 10) : v;
  if (!Number.isInteger(n) || (n as number) < 2000 || (n as number) > 2100) {
    return 'season must be an integer between 2000 and 2100';
  }
  return n as number;
}

// plantingDate on POST / PATCH: a planting always has a date, so null is
// refused. Returns an error message, or null when the value is a date string.
function plantingDateError(v: unknown): string | null {
  if (v === null) return 'plantingDate is required';
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    return 'plantingDate must be a date string (YYYY-MM-DD)';
  }
  return null;
}

function isStartMethod(v: unknown): v is StartMethod {
  return v === 'sown' || v === 'transplanted';
}

const START_METHOD_ERROR = "startMethod must be 'sown' or 'transplanted'";

// The sowing-event key for a planting: its personal seed when it has one,
// otherwise its Cambium seed.
function plantingSeedKey(row: { seed_id: string | null; cambium_seed_id: string | null }): SeedKey {
  return row.seed_id !== null
    ? { kind: 'seed', id: Number(row.seed_id) }
    : { kind: 'cambium', id: Number(row.cambium_seed_id) };
}

// Runs fn in a transaction on its own client: COMMIT when it resolves,
// ROLLBACK when it throws.
async function inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Best-effort follow-ups once a planting write has committed. Derives the
// planting's growth (when plantingId is given) so the response carries its new
// stage, then refreshes the garden's harvest badge and drops cached metrics. A
// failure is logged and never fails the request: the write stands and the
// nightly job catches up.
async function afterPlantingWrite(
  gardenId: string,
  accountId: number | null,
  plantingId: string | null,
): Promise<void> {
  if (plantingId !== null) {
    try {
      await deriveGrowth({ plantingIds: [Number(plantingId)], db });
    } catch (err) {
      logger.error('Deriving growth after a planting write failed', err, { plantingId });
    }
  }
  try {
    await recomputeHarvestableCount(db, Number(gardenId));
  } catch (err) {
    logger.error('Recomputing harvestable count after a planting write failed', err, { gardenId });
  }
  if (accountId !== null) invalidateMetrics(accountId);
}

// ── gardenPlantingsRouter: GET /api/gardens/:gardenId/plantings ───────────────

gardenPlantingsRouter.get('/', async (req, res) => {
  const { gardenId } = req.params as Record<string, string>;

  if (!isNumericId(gardenId)) {
    return res.status(400).json({ error: 'Invalid id' });
  }

  try {
    const found = await ownGarden(gardenId, req.session!);
    if (!found) return res.status(404).json({ error: 'Garden not found' });

    let season: number;
    if (req.query.season !== undefined) {
      const result = validateSeason(req.query.season);
      if (typeof result === 'string') return res.status(400).json({ error: result });
      season = result;
    } else {
      season = currentSeason();
    }

    const { rows } = await db.query<PlantingRow>(
      `${PLANTING_GET_QUERY}
       WHERE p.garden_id = $1 AND p.season = $2
       ORDER BY p.bed_id ASC, p.created_at ASC`,
      [gardenId, season],
    );
    res.json({ data: rows.map(formatPlanting) });
  } catch (err) {
    logger.error('GET /gardens/:gardenId/plantings failed', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── gardenPlantingsRouter: PATCH /api/gardens/:gardenId/plantings/displayed-stage
// Records that the client has shown each planting's current growth stage by
// copying growth_stage into displayed_growth_stage. The only route that writes
// displayed_growth_stage; leaves updated_at alone (not a user edit).

gardenPlantingsRouter.patch('/displayed-stage', writeLimiter, async (req, res) => {
  const { gardenId } = req.params as Record<string, string>;

  if (!isNumericId(gardenId)) {
    return res.status(400).json({ error: 'Invalid id' });
  }

  const { plantingIds } = (req.body ?? {}) as Record<string, unknown>;
  if (
    !Array.isArray(plantingIds) ||
    plantingIds.length < 1 ||
    plantingIds.length > MAX_DISPLAYED_STAGE_IDS
  ) {
    return res.status(400).json({
      error: `plantingIds must be an array of 1 to ${MAX_DISPLAYED_STAGE_IDS} ids`,
    });
  }
  // Digit strings only; isNumericId caps them at int4.
  if (!plantingIds.every(id => isNumericId(id))) {
    return res.status(400).json({ error: 'plantingIds must contain numeric id strings' });
  }

  try {
    const found = await ownGarden(gardenId, req.session!);
    if (!found) return res.status(404).json({ error: 'Garden not found' });

    const result = await db.query(
      `UPDATE plantings SET displayed_growth_stage = growth_stage
       WHERE garden_id = $1 AND id = ANY($2::bigint[]) AND growth_stage IS NOT NULL`,
      [gardenId, plantingIds],
    );
    res.json({ updated: result.rowCount ?? 0 });
  } catch (err) {
    logger.error('PATCH /gardens/:gardenId/plantings/displayed-stage failed', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── plantingsNestedRouter: GET /api/gardens/:gardenId/beds/:bedId/plantings ──

plantingsNestedRouter.get('/', async (req, res) => {
  const { gardenId, bedId } = req.params as Record<string, string>;

  if (!isNumericId(gardenId)) return res.status(400).json({ error: 'Invalid id' });
  if (!isNumericId(bedId)) return res.status(400).json({ error: 'Invalid id' });

  try {
    const gardenFound = await ownGarden(gardenId, req.session!);
    if (!gardenFound) return res.status(404).json({ error: 'Garden not found' });

    const bed = await bedInGarden(bedId, gardenId);
    if (!bed) return res.status(404).json({ error: 'Bed not found' });

    const { rows } = await db.query<PlantingRow>(
      `${PLANTING_GET_QUERY}
       WHERE p.bed_id = $1
       ORDER BY p.created_at ASC`,
      [bedId],
    );
    res.json({ data: rows.map(formatPlanting) });
  } catch (err) {
    logger.error('GET /gardens/:gardenId/beds/:bedId/plantings failed', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── plantingsNestedRouter: POST /api/gardens/:gardenId/beds/:bedId/plantings ─

plantingsNestedRouter.post('/', writeLimiter, async (req, res) => {
  const accountId = req.session!.account?.id ?? null;
  const sessionId = req.session!.id;
  const { gardenId, bedId } = req.params as Record<string, string>;

  if (!isNumericId(gardenId)) return res.status(400).json({ error: 'Invalid id' });
  if (!isNumericId(bedId)) return res.status(400).json({ error: 'Invalid id' });

  try {
    const gardenFound = await ownGarden(gardenId, req.session!);
    if (!gardenFound) return res.status(404).json({ error: 'Garden not found' });

    const bed = await bedInGarden(bedId, gardenId);
    if (!bed) return res.status(404).json({ error: 'Bed not found' });

    const body = req.body as Record<string, unknown>;

    // Reject growth fields
    for (const key of GROWTH_KEYS) {
      if (key in body) {
        return res.status(400).json({ error: 'growth fields are derived nightly and cannot be set' });
      }
    }

    // Reject season
    if ('season' in body) {
      return res.status(400).json({ error: 'season cannot be changed' });
    }

    // Exactly one of seedId / cambiumSeedId
    const hasSeedId = body.seedId !== undefined;
    const hasCambiumSeedId = body.cambiumSeedId !== undefined;

    if (!hasSeedId && !hasCambiumSeedId) {
      return res.status(400).json({ error: 'exactly one of seedId or cambiumSeedId is required' });
    }
    if (hasSeedId && hasCambiumSeedId) {
      return res.status(400).json({ error: 'provide exactly one of seedId or cambiumSeedId, not both' });
    }

    let seedId: number | null = null;
    let cambiumSeedId: number | null = null;
    let requestSeedSourceId: string | null = null;

    if (hasSeedId) {
      const raw = body.seedId;
      const parsed = typeof raw === 'string' ? parseInt(raw, 10) : raw;
      if (!Number.isInteger(parsed) || (parsed as number) <= 0) {
        return res.status(400).json({ error: 'seedId must be a positive integer' });
      }
      seedId = parsed as number;
      const { rows } = await db.query(
        `SELECT id, cambium_source_id::text AS cambium_source_id
         FROM seeds WHERE id = $1 AND (owner_id = $2 OR guest_session_id = $3)`,
        [seedId, accountId, sessionId],
      );
      if (rows.length === 0) {
        return res.status(400).json({ error: 'seedId not found in your catalogue' });
      }
      requestSeedSourceId = (rows[0].cambium_source_id as string | null) ?? null;
    } else {
      const raw = body.cambiumSeedId;
      const parsed = typeof raw === 'string' ? parseInt(raw, 10) : raw;
      if (!Number.isInteger(parsed) || (parsed as number) <= 0) {
        return res.status(400).json({ error: 'cambiumSeedId must be a positive integer' });
      }
      cambiumSeedId = parsed as number;
      const { rows } = await db.query(
        `SELECT id FROM cambium.seeds WHERE id = $1 AND moderation_status = 'active'`,
        [cambiumSeedId],
      );
      if (rows.length === 0) {
        return res.status(400).json({ error: 'cambiumSeedId not found' });
      }
    }

    // quantity (optional, default 1)
    let quantity = 1;
    if (body.quantity !== undefined) {
      if (!Number.isInteger(body.quantity) || (body.quantity as number) < 1 || (body.quantity as number) > 9999) {
        return res.status(400).json({ error: 'quantity must be an integer between 1 and 9999' });
      }
      quantity = body.quantity as number;
    }

    // plantingDate (optional): placing a plant sows it, today unless told otherwise.
    let plantingDate = todayPacific();
    if (body.plantingDate !== undefined) {
      const dateErr = plantingDateError(body.plantingDate);
      if (dateErr) return res.status(400).json({ error: dateErr });
      plantingDate = body.plantingDate as string;
    }

    // startMethod (optional, default 'sown')
    let startMethod: StartMethod = 'sown';
    if (body.startMethod !== undefined) {
      if (!isStartMethod(body.startMethod)) {
        return res.status(400).json({ error: START_METHOD_ERROR });
      }
      startMethod = body.startMethod;
    }

    // Position based on bed type
    let cellX: number | null = null;
    let cellY: number | null = null;
    let pointX: number | null = null;
    let pointY: number | null = null;

    if (bed.type === 'grid') {
      if (body.point !== undefined) {
        return res.status(400).json({ error: 'this bed uses cell coordinates' });
      }
      if (body.cell === undefined) {
        return res.status(400).json({ error: 'cell is required for grid beds' });
      }
      const cellErr = validateCell(body.cell, bed);
      if (cellErr) return res.status(400).json({ error: cellErr });
      const c = body.cell as Record<string, number>;
      cellX = c.x;
      cellY = c.y;
    } else {
      if (body.cell !== undefined) {
        return res.status(400).json({ error: 'this bed uses point coordinates' });
      }
      if (body.point === undefined) {
        return res.status(400).json({ error: 'point is required for freeform beds' });
      }
      const pointErr = validatePoint(body.point);
      if (pointErr) return res.status(400).json({ error: pointErr });
      const p = body.point as Record<string, number>;
      pointX = p.x;
      pointY = p.y;
    }

    const requestKey: SeedKey =
      seedId !== null ? { kind: 'seed', id: seedId } : { kind: 'cambium', id: cambiumSeedId! };

    // Each write below shares a transaction with its sowing-event sync. Nothing
    // else rebuilds the event, so a failed sync undoes the placement.
    const insertPlanting = async (client: PoolClient): Promise<string> => {
      const { rows: insertRows } = await client.query<{ id: string }>(
        `INSERT INTO plantings
           (bed_id, garden_id, season, seed_id, cambium_seed_id, quantity, planting_date,
            start_method, cell_x, cell_y, point_x, point_y)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id::text`,
        [bedId, gardenId, bed.season, seedId, cambiumSeedId, quantity, plantingDate,
         startMethod, cellX, cellY, pointX, pointY],
      );
      await syncSowingEvent(client, Number(gardenId), requestKey, bed.season);
      return insertRows[0].id;
    };

    let outcome: PlaceOutcome;

    if (bed.type !== 'grid') {
      // Freeform beds have no cell limit, so cap the plantings per bed. Lock the
      // bed row so parallel creates count and insert one at a time. Take the
      // garden's KEY SHARE (which the insert's FK check needs anyway) before the
      // bed lock, so locks are always taken garden → bed; the sowing-event
      // advisory lock comes last, inside the sync.
      outcome = await inTransaction(async (client): Promise<PlaceOutcome> => {
        const gardenLock = await client.query('SELECT 1 FROM gardens WHERE id = $1 FOR KEY SHARE', [gardenId]);
        if (gardenLock.rowCount === 0) {
          return { kind: 'refused', status: 404, body: { error: 'Garden not found' } };
        }
        const cap = await withinCap(client, {
          lockSql: 'SELECT 1 FROM beds WHERE id = $1 FOR NO KEY UPDATE',
          countSql: 'SELECT COUNT(*)::int AS n FROM plantings WHERE bed_id = $1',
          params: [bedId],
          max: LIMITS.plantingsPerFreeformBed,
        });
        if (cap === 'missing') {
          return { kind: 'refused', status: 404, body: { error: 'Bed not found' } };
        }
        if (cap === 'full') {
          return {
            kind: 'refused',
            status: 409,
            body: { error: `A bed can have up to ${LIMITS.plantingsPerFreeformBed} plantings.` },
          };
        }
        return { kind: 'placed', id: await insertPlanting(client), merged: false };
      });
    } else {
      // Grid bed: one planting per cell. Same plant merges; a different plant is refused.
      const requestIdentity =
        cambiumSeedId !== null ? String(cambiumSeedId) : requestSeedSourceId;

      // A merge only adds to the quantity: the planting keeps its own date and
      // start method, and its event is synced on its own seed key.
      const resolveOccupied = async (client: PoolClient, occ: OccupantRow): Promise<PlaceOutcome> => {
        const sameSeedRecord =
          (seedId !== null && occ.seed_id === String(seedId)) ||
          (cambiumSeedId !== null && occ.cambium_seed_id === String(cambiumSeedId));
        const sameIdentity =
          occ.cambium_identity !== null && occ.cambium_identity === requestIdentity;
        if (!sameSeedRecord && !sameIdentity) {
          return { kind: 'refused', status: 409, body: cellOccupiedBody(occ) };
        }
        // SQL mirrors mergedQuantity() in lib/plantingQuantity.ts; computed in SQL
        // so concurrent merges don't lose an update.
        const { rows: merged } = await client.query<{ id: string }>(
          `UPDATE plantings
           SET quantity = LEAST(quantity + $1, GREATEST(quantity, $2)), updated_at = NOW()
           WHERE id = $3 RETURNING id::text`,
          [quantity, UI_MAX_QUANTITY, occ.id],
        );
        if (merged.length === 0) return { kind: 'vanished', plantingId: occ.id };
        await syncSowingEvent(client, Number(gardenId), plantingSeedKey(occ), bed.season);
        return { kind: 'placed', id: occ.id, merged: true };
      };

      const findOccupant = async (client: PoolClient): Promise<OccupantRow | null> => {
        const { rows } = await client.query<OccupantRow>(
          `SELECT p.id::text, p.seed_id::text, p.cambium_seed_id::text,
                  p.quantity,
                  COALESCE(p.cambium_seed_id, s.cambium_source_id)::text
                    AS cambium_identity,
                  COALESCE(cs.common_name, s.common_name) AS common_name
           FROM plantings p
           LEFT JOIN seeds s          ON s.id  = p.seed_id
           LEFT JOIN cambium.seeds cs ON cs.id = COALESCE(p.cambium_seed_id, s.cambium_source_id)
           WHERE p.bed_id = $1 AND p.cell_x = $2 AND p.cell_y = $3`,
          [bedId, cellX, cellY],
        );
        return rows[0] ?? null;
      };

      try {
        outcome = await inTransaction(async (client): Promise<PlaceOutcome> => {
          const occupant = await findOccupant(client);
          if (occupant) return resolveOccupied(client, occupant);
          return { kind: 'placed', id: await insertPlanting(client), merged: false };
        });
      } catch (err) {
        if (!isCellIndexViolation(err)) throw err;
        // Lost a race: someone filled the cell between lookup and insert. The
        // failed insert aborted that transaction, so look again in a fresh one.
        outcome = await inTransaction(async (client) => {
          const raced = await findOccupant(client);
          if (!raced) throw err;
          return resolveOccupied(client, raced);
        });
      }
    }

    if (outcome.kind === 'refused') return res.status(outcome.status).json(outcome.body);
    if (outcome.kind === 'vanished') {
      logger.error('POST /gardens/:gardenId/beds/:bedId/plantings merge target vanished before the merge UPDATE', undefined, {
        plantingId: outcome.plantingId,
      });
      return res.status(500).json({ error: 'Internal server error' });
    }

    await afterPlantingWrite(gardenId, accountId, outcome.id);
    const { rows } = await db.query<PlantingRow>(`${PLANTING_GET_QUERY} WHERE p.id = $1`, [outcome.id]);
    return res
      .status(outcome.merged ? 200 : 201)
      .json({ ...formatPlanting(rows[0]), merged: outcome.merged });
  } catch (err) {
    logger.error('POST /gardens/:gardenId/beds/:bedId/plantings failed', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── plantingsFlatRouter: PATCH /api/plantings/:id ────────────────────────────

plantingsFlatRouter.patch('/:id', writeLimiter, async (req, res) => {
  const accountId = req.session!.account?.id ?? null;
  const sessionId = req.session!.id;
  const plantingId = req.params.id as string;

  if (!isNumericId(plantingId)) return res.status(400).json({ error: 'Invalid id' });

  try {
    const { rows: existing } = await db.query<PatchPlantingRow>(
      `SELECT p.id::text, p.bed_id::text, p.garden_id::text, p.season,
              p.seed_id::text, p.cambium_seed_id::text,
              p.quantity, ${PLANTING_DATE_SQL}, p.start_method,
              p.cell_x, p.cell_y, p.point_x, p.point_y,
              p.growth_stage_pct, p.growth_stage, p.displayed_growth_stage,
              p.harvest_ready, p.harvest_window_end,
              p.indicator_dismissed_at, p.created_at, p.updated_at,
              b.type AS bed_type, b.grid_cols, b.grid_rows
       FROM plantings p
       JOIN gardens g ON g.id = p.garden_id
       JOIN beds b ON b.id = p.bed_id
       WHERE p.id = $1 AND (g.owner_id = $2 OR g.guest_session_id = $3)`,
      [plantingId, accountId, sessionId],
    );
    if (existing.length === 0) return res.status(404).json({ error: 'Planting not found' });

    const planting = existing[0];
    const body = req.body as Record<string, unknown>;

    // Reject immutable / nightly fields
    for (const key of GROWTH_KEYS) {
      if (key in body) {
        return res.status(400).json({ error: 'growth fields are derived nightly and cannot be set' });
      }
    }
    if ('season' in body) return res.status(400).json({ error: 'season cannot be changed' });
    if ('seedId' in body) return res.status(400).json({ error: 'seedId cannot be changed after creation' });
    if ('cambiumSeedId' in body) return res.status(400).json({ error: 'cambiumSeedId cannot be changed after creation' });

    const updates: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (body.quantity !== undefined) {
      if (!Number.isInteger(body.quantity) || (body.quantity as number) < 1 || (body.quantity as number) > 9999) {
        return res.status(400).json({ error: 'quantity must be an integer between 1 and 9999' });
      }
      updates.push(`quantity = $${idx++}`);
      values.push(body.quantity);
    }

    if (body.plantingDate !== undefined) {
      const dateErr = plantingDateError(body.plantingDate);
      if (dateErr) return res.status(400).json({ error: dateErr });
      updates.push(`planting_date = $${idx++}`);
      values.push(body.plantingDate);
    }

    if (body.startMethod !== undefined) {
      if (!isStartMethod(body.startMethod)) {
        return res.status(400).json({ error: START_METHOD_ERROR });
      }
      updates.push(`start_method = $${idx++}`);
      values.push(body.startMethod);
    }

    if (body.cell !== undefined) {
      if (planting.bed_type !== 'grid') {
        return res.status(400).json({ error: 'this bed uses point coordinates' });
      }
      const bedInfo: BedInfo = {
        id: planting.bed_id,
        season: planting.season,
        type: 'grid',
        grid_cols: planting.grid_cols,
        grid_rows: planting.grid_rows,
      };
      const cellErr = validateCell(body.cell, bedInfo);
      if (cellErr) return res.status(400).json({ error: cellErr });
      const c = body.cell as Record<string, number>;
      const { rows: occupants } = await db.query<PlantingRow>(
        `${PLANTING_GET_QUERY}
         WHERE p.bed_id = $1 AND p.cell_x = $2 AND p.cell_y = $3 AND p.id <> $4`,
        [planting.bed_id, c.x, c.y, plantingId],
      );
      if (occupants.length > 0) {
        return res.status(409).json(cellOccupiedBody(occupants[0]));
      }
      updates.push(`cell_x = $${idx++}`);
      values.push(c.x);
      updates.push(`cell_y = $${idx++}`);
      values.push(c.y);
    }

    if (body.point !== undefined) {
      if (planting.bed_type !== 'freeform') {
        return res.status(400).json({ error: 'this bed uses cell coordinates' });
      }
      const pointErr = validatePoint(body.point);
      if (pointErr) return res.status(400).json({ error: pointErr });
      const p = body.point as Record<string, number>;
      updates.push(`point_x = $${idx++}`);
      values.push(p.x);
      updates.push(`point_y = $${idx++}`);
      values.push(p.y);
    }

    if (body.dismissIndicator !== undefined) {
      if (body.dismissIndicator !== true) {
        return res.status(400).json({ error: 'dismissIndicator must be true' });
      }
      // COALESCE makes this idempotent: already-set value is preserved
      updates.push(`indicator_dismissed_at = COALESCE(indicator_dismissed_at, NOW())`);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    updates.push(`updated_at = NOW()`);
    values.push(plantingId);

    // Only the date moves the sowing event; growth also follows the start
    // method. A dismissed indicator needs no derive: the badge count and the
    // client already skip dismissed plantings, and the nightly run clears
    // harvest_ready.
    const redated = body.plantingDate !== undefined;
    const growthChanged = redated || body.startMethod !== undefined;

    try {
      await inTransaction(async (client) => {
        await client.query(
          `UPDATE plantings SET ${updates.join(', ')} WHERE id = $${idx}`,
          values,
        );
        if (redated) {
          await syncSowingEvent(
            client, Number(planting.garden_id), plantingSeedKey(planting), planting.season,
          );
        }
      });
    } catch (err) {
      if (!isCellIndexViolation(err) || body.cell === undefined) throw err;
      // Lost a race for the target cell; report whoever holds it now.
      const c = body.cell as Record<string, number>;
      const { rows: occ } = await db.query<PlantingRow>(
        `${PLANTING_GET_QUERY}
         WHERE p.bed_id = $1 AND p.cell_x = $2 AND p.cell_y = $3 AND p.id <> $4`,
        [planting.bed_id, c.x, c.y, plantingId],
      );
      if (occ.length === 0) throw err;
      return res.status(409).json(cellOccupiedBody(occ[0]));
    }
    await afterPlantingWrite(planting.garden_id, accountId, growthChanged ? plantingId : null);
    const { rows } = await db.query<PlantingRow>(
      `${PLANTING_GET_QUERY} WHERE p.id = $1`,
      [plantingId],
    );
    res.json(formatPlanting(rows[0]));
  } catch (err) {
    logger.error('PATCH /plantings/:id failed', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── plantingsFlatRouter: DELETE /api/plantings/:id ───────────────────────────

plantingsFlatRouter.delete('/:id', writeLimiter, async (req, res) => {
  const accountId = req.session!.account?.id ?? null;
  const sessionId = req.session!.id;
  const plantingId = req.params.id as string;

  if (!isNumericId(plantingId)) return res.status(400).json({ error: 'Invalid id' });

  try {
    // The event sync shares the delete's transaction: with the last planting
    // gone the event is un-done, otherwise it follows the earliest date left.
    // The sow lock comes before the DELETE, whose FK SET NULL row-locks the
    // event: taking them the other way round could deadlock with a POST or
    // PATCH that holds the sow lock and then updates the event.
    const deleted = await inTransaction(async (client) => {
      const { rows } = await client.query<{
        garden_id: string;
        seed_id: string | null;
        cambium_seed_id: string | null;
        season: number;
      }>(
        `SELECT p.garden_id::text, p.seed_id::text, p.cambium_seed_id::text, p.season
         FROM plantings p
         JOIN gardens g ON g.id = p.garden_id
         WHERE p.id = $1 AND (g.owner_id = $2 OR g.guest_session_id = $3)`,
        [plantingId, accountId, sessionId],
      );
      const row = rows[0];
      if (!row) return null;
      const gardenNum = Number(row.garden_id);
      const seedKey = plantingSeedKey(row);
      await lockSowingKey(client, gardenNum, seedKey, row.season);
      const { rowCount } = await client.query('DELETE FROM plantings WHERE id = $1', [plantingId]);
      if (!rowCount) return null;
      await syncSowingEvent(client, gardenNum, seedKey, row.season);
      return row;
    });
    if (!deleted) return res.status(404).json({ error: 'Planting not found' });
    await afterPlantingWrite(deleted.garden_id, accountId, null);
    res.status(204).send();
  } catch (err) {
    logger.error('DELETE /plantings/:id failed', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

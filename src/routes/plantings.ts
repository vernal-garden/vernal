import { Router } from 'express';
import { db } from '../lib/db';
import { requireAuth } from '../middleware/auth';

// ── Three routers, all with mergeParams ──────────────────────────────────────

export const plantingsNestedRouter = Router({ mergeParams: true });  // /api/gardens/:gardenId/beds/:bedId/plantings
export const gardenPlantingsRouter = Router({ mergeParams: true });  // /api/gardens/:gardenId/plantings
export const plantingsFlatRouter = Router({ mergeParams: true });    // /api/plantings

plantingsNestedRouter.use(requireAuth);
gardenPlantingsRouter.use(requireAuth);
plantingsFlatRouter.use(requireAuth);

// ── Types ────────────────────────────────────────────────────────────────────

interface PlantingRow {
  id: string;
  bed_id: string;
  garden_id: string;
  season: number;
  seed_id: string | null;
  cambium_seed_id: string | null;
  quantity: number;
  planting_date: string | null;
  cell_x: number | null;
  cell_y: number | null;
  point_x: string | null;
  point_y: string | null;
  growth_stage_pct: string | null;
  harvest_ready: boolean;
  harvest_window_end: string | null;
  indicator_dismissed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface BedInfo {
  id: string;
  season: number;
  type: 'grid' | 'freeform';
  grid_cols: number | null;
  grid_rows: number | null;
}

interface PatchPlantingRow extends PlantingRow {
  bed_type: 'grid' | 'freeform';
  grid_cols: number | null;
  grid_rows: number | null;
}

const PLANTING_SELECT = `
  id::text, bed_id::text, garden_id::text, season,
  seed_id::text, cambium_seed_id::text,
  quantity, planting_date, cell_x, cell_y, point_x, point_y,
  growth_stage_pct, harvest_ready, harvest_window_end,
  indicator_dismissed_at, created_at, updated_at
`;

const GROWTH_KEYS = ['growthStagePct', 'harvestReady', 'harvestWindowEnd'];

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
    cell: row.cell_x !== null ? { x: row.cell_x, y: row.cell_y } : null,
    point: row.point_x !== null ? { x: Number(row.point_x), y: Number(row.point_y) } : null,
    growth: {
      stagePct: row.growth_stage_pct !== null ? Number(row.growth_stage_pct) : null,
      harvestReady: row.harvest_ready,
      harvestWindowEnd: row.harvest_window_end,
      indicatorDismissedAt: row.indicator_dismissed_at,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── Shared helpers ────────────────────────────────────────────────────────────

async function ownGarden(gardenId: string, accountId: number): Promise<boolean> {
  const { rows } = await db.query(
    'SELECT id FROM gardens WHERE id = $1 AND owner_id = $2',
    [gardenId, accountId],
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
  return null;
}

function validateSeason(v: unknown): number | string {
  const n = typeof v === 'string' ? parseInt(v, 10) : v;
  if (!Number.isInteger(n) || (n as number) < 2000 || (n as number) > 2100) {
    return 'season must be an integer between 2000 and 2100';
  }
  return n as number;
}

function isValidDate(v: unknown): boolean {
  return v === null || (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v));
}

function isValidId(v: string): boolean {
  return /^\d+$/.test(v);
}

// ── gardenPlantingsRouter: GET /api/gardens/:gardenId/plantings ───────────────

gardenPlantingsRouter.get('/', async (req, res) => {
  const accountId = req.session!.account!.id;
  const { gardenId } = req.params as Record<string, string>;

  if (!isValidId(gardenId)) {
    return res.status(400).json({ error: 'Invalid id' });
  }

  try {
    const found = await ownGarden(gardenId, accountId);
    if (!found) return res.status(404).json({ error: 'Garden not found' });

    let season: number;
    if (req.query.season !== undefined) {
      const result = validateSeason(req.query.season);
      if (typeof result === 'string') return res.status(400).json({ error: result });
      season = result;
    } else {
      season = new Date().getFullYear();
    }

    const { rows } = await db.query<PlantingRow>(
      `SELECT ${PLANTING_SELECT}
       FROM plantings
       WHERE garden_id = $1 AND season = $2
       ORDER BY bed_id ASC, created_at ASC`,
      [gardenId, season],
    );
    res.json({ data: rows.map(formatPlanting) });
  } catch (err) {
    console.error('GET /gardens/:gardenId/plantings error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── plantingsNestedRouter: GET /api/gardens/:gardenId/beds/:bedId/plantings ──

plantingsNestedRouter.get('/', async (req, res) => {
  const accountId = req.session!.account!.id;
  const { gardenId, bedId } = req.params as Record<string, string>;

  if (!isValidId(gardenId)) return res.status(400).json({ error: 'Invalid id' });
  if (!isValidId(bedId)) return res.status(400).json({ error: 'Invalid id' });

  try {
    const gardenFound = await ownGarden(gardenId, accountId);
    if (!gardenFound) return res.status(404).json({ error: 'Garden not found' });

    const bed = await bedInGarden(bedId, gardenId);
    if (!bed) return res.status(404).json({ error: 'Bed not found' });

    const { rows } = await db.query<PlantingRow>(
      `SELECT ${PLANTING_SELECT}
       FROM plantings
       WHERE bed_id = $1
       ORDER BY created_at ASC`,
      [bedId],
    );
    res.json({ data: rows.map(formatPlanting) });
  } catch (err) {
    console.error('GET /.../beds/:bedId/plantings error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── plantingsNestedRouter: POST /api/gardens/:gardenId/beds/:bedId/plantings ─

plantingsNestedRouter.post('/', async (req, res) => {
  const accountId = req.session!.account!.id;
  const { gardenId, bedId } = req.params as Record<string, string>;

  if (!isValidId(gardenId)) return res.status(400).json({ error: 'Invalid id' });
  if (!isValidId(bedId)) return res.status(400).json({ error: 'Invalid id' });

  try {
    const gardenFound = await ownGarden(gardenId, accountId);
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

    if (hasSeedId) {
      const raw = body.seedId;
      const parsed = typeof raw === 'string' ? parseInt(raw, 10) : raw;
      if (!Number.isInteger(parsed) || (parsed as number) <= 0) {
        return res.status(400).json({ error: 'seedId must be a positive integer' });
      }
      seedId = parsed as number;
      const { rows } = await db.query(
        'SELECT id FROM seeds WHERE id = $1 AND owner_id = $2',
        [seedId, accountId],
      );
      if (rows.length === 0) {
        return res.status(400).json({ error: 'seedId not found in your catalogue' });
      }
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

    // plantingDate (optional)
    if (body.plantingDate !== undefined && !isValidDate(body.plantingDate)) {
      return res.status(400).json({ error: 'plantingDate must be a date string (YYYY-MM-DD) or null' });
    }
    const plantingDate = (body.plantingDate as string | null | undefined) ?? null;

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

    const { rows } = await db.query<PlantingRow>(
      `INSERT INTO plantings
         (bed_id, garden_id, season, seed_id, cambium_seed_id, quantity, planting_date,
          cell_x, cell_y, point_x, point_y)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING ${PLANTING_SELECT}`,
      [bedId, gardenId, bed.season, seedId, cambiumSeedId, quantity, plantingDate,
       cellX, cellY, pointX, pointY],
    );
    res.status(201).json(formatPlanting(rows[0]));
  } catch (err) {
    console.error('POST /.../beds/:bedId/plantings error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── plantingsFlatRouter: PATCH /api/plantings/:id ────────────────────────────

plantingsFlatRouter.patch('/:id', async (req, res) => {
  const accountId = req.session!.account!.id;
  const plantingId = req.params.id as string;

  if (!isValidId(plantingId)) return res.status(400).json({ error: 'Invalid id' });

  try {
    const { rows: existing } = await db.query<PatchPlantingRow>(
      `SELECT p.id::text, p.bed_id::text, p.garden_id::text, p.season,
              p.seed_id::text, p.cambium_seed_id::text,
              p.quantity, p.planting_date, p.cell_x, p.cell_y, p.point_x, p.point_y,
              p.growth_stage_pct, p.harvest_ready, p.harvest_window_end,
              p.indicator_dismissed_at, p.created_at, p.updated_at,
              b.type AS bed_type, b.grid_cols, b.grid_rows
       FROM plantings p
       JOIN gardens g ON g.id = p.garden_id
       JOIN beds b ON b.id = p.bed_id
       WHERE p.id = $1 AND g.owner_id = $2`,
      [plantingId, accountId],
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

    if ('plantingDate' in body) {
      if (!isValidDate(body.plantingDate)) {
        return res.status(400).json({ error: 'plantingDate must be a date string (YYYY-MM-DD) or null' });
      }
      updates.push(`planting_date = $${idx++}`);
      values.push(body.plantingDate ?? null);
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

    const { rows } = await db.query<PlantingRow>(
      `UPDATE plantings SET ${updates.join(', ')}
       WHERE id = $${idx}
       RETURNING ${PLANTING_SELECT}`,
      values,
    );
    res.json(formatPlanting(rows[0]));
  } catch (err) {
    console.error('PATCH /plantings/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── plantingsFlatRouter: DELETE /api/plantings/:id ───────────────────────────

plantingsFlatRouter.delete('/:id', async (req, res) => {
  const accountId = req.session!.account!.id;
  const plantingId = req.params.id as string;

  if (!isValidId(plantingId)) return res.status(400).json({ error: 'Invalid id' });

  try {
    const { rows } = await db.query(
      `DELETE FROM plantings p
       USING gardens g
       WHERE p.id = $1 AND g.id = p.garden_id AND g.owner_id = $2
       RETURNING p.id`,
      [plantingId, accountId],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Planting not found' });
    res.status(204).send();
  } catch (err) {
    console.error('DELETE /plantings/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

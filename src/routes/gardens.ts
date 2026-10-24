import crypto from 'crypto';
import express, { Router } from 'express';
import { db } from '../lib/db';
import { logger } from '../lib/logger';
import { requireSession } from '../middleware/auth';
import { writeLimiter } from '../middleware/rateLimiters';
import { isNumericId, textField } from '../lib/validation';
import { LIMITS, withinCap } from '../lib/limits';
import { currentSeason } from '../lib/season';
import { uploadToR2, isR2ConfigError, ownedThumbnailKey } from '../lib/r2';
import { queueR2Deletions, queueDeletedGardens, drainSoon } from '../lib/r2Cleanup';
import { processThumbnail, ImageRejectedError, ImageBusyError } from '../lib/imageProcessing';

const router = Router();
router.use(requireSession);

// ── Type helpers ──────────────────────────────────────────────────────────────

interface GardenRow {
  id: string;
  owner_id: string | null;
  name: string;
  style: string;
  growing_method: string;
  description: string | null;
  zone: string;
  zone_location_label: string | null;
  thumbnail_url: string | null;
  last_accessed_at: string;
  harvestable_count: number;
  has_companion_warnings: boolean;
  created_at: string;
  updated_at: string;
}

interface GardenListRow extends GardenRow {
  active_planting_count: number;
}

interface BedRow {
  id: string;
  garden_id: string;
  season: number;
  type: 'grid' | 'freeform';
  label: string;
  grid_x: number | null;
  grid_y: number | null;
  grid_cols: number | null;
  grid_rows: number | null;
  freeform_points: number[] | null;
  freeform_closed: boolean | null;
  created_at: string;
  updated_at: string;
  planting_count?: number;
}

// Column lists kept as constants so any future schema change is one edit.
const GARDEN_SELECT = `
  id::text, owner_id::text, name, style, growing_method, description, zone, zone_location_label,
  thumbnail_url, last_accessed_at, harvestable_count, has_companion_warnings,
  created_at, updated_at
`;

const BED_SELECT = `
  id::text, garden_id::text, season, type, label,
  grid_x, grid_y, grid_cols, grid_rows,
  freeform_points, freeform_closed,
  created_at, updated_at
`;

function formatGarden(row: GardenRow) {
  return {
    id: row.id,
    name: row.name,
    style: row.style,
    growingMethod: row.growing_method,
    description: row.description,
    zone: row.zone,
    zoneLocationLabel: row.zone_location_label,
    thumbnailUrl: row.thumbnail_url,
    lastAccessedAt: row.last_accessed_at,
    harvestableCount: row.harvestable_count,
    hasCompanionWarnings: row.has_companion_warnings,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function formatBed(row: BedRow) {
  return {
    id: row.id,
    gardenId: row.garden_id,
    season: row.season,
    type: row.type,
    label: row.label,
    grid:
      row.type === 'grid'
        ? { x: row.grid_x, y: row.grid_y, cols: row.grid_cols, rows: row.grid_rows }
        : null,
    freeform:
      row.type === 'freeform'
        ? { points: row.freeform_points, closed: row.freeform_closed }
        : null,
    plantingCount: row.planting_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── Thumbnail helpers ─────────────────────────────────────────────────────────

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const VALID_STYLES = new Set(['grid', 'freeform']);
const VALID_GROWING_METHODS = new Set(['square_foot', 'container', 'raised_bed', 'in_ground']);

// ── Validation helpers ────────────────────────────────────────────────────────

// Geometry bounds: keep values well inside INTEGER columns and sane canvas sizes.
const MAX_GRID_CELLS = 100;
const MAX_COORD = 100000;

function inCoordRange(n: number): boolean {
  return n >= -MAX_COORD && n <= MAX_COORD;
}

const GARDEN_CAP_ERROR = `You can have up to ${LIMITS.gardensPerAccount} gardens.`;
const BED_CAP_ERROR = `A garden can have up to ${LIMITS.bedsPerGarden} beds.`;

function validateSeason(v: unknown): { value: number } | { error: string } {
  const n = typeof v === 'string' ? parseInt(v, 10) : v;
  if (!Number.isInteger(n) || (n as number) < 2000 || (n as number) > 2100) {
    return { error: 'season must be an integer between 2000 and 2100' };
  }
  return { value: n as number };
}

// `stored` is the bed's current cols/rows on PATCH: a dimension left unchanged
// skips the upper bound, so a bed created before the cap can still be moved.
function validateGrid(obj: unknown, stored?: { cols: number | null; rows: number | null }): string | null {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return 'grid must be an object with x, y, cols, rows';
  }
  const g = obj as Record<string, unknown>;
  if (
    !Number.isInteger(g.x) ||
    !Number.isInteger(g.y) ||
    !Number.isInteger(g.cols) ||
    !Number.isInteger(g.rows)
  ) {
    return 'grid.x, grid.y, grid.cols, and grid.rows must all be integers';
  }
  const colsMax = stored?.cols === g.cols ? Infinity : MAX_GRID_CELLS;
  const rowsMax = stored?.rows === g.rows ? Infinity : MAX_GRID_CELLS;
  if ((g.cols as number) < 1 || (g.cols as number) > colsMax) {
    return `grid.cols must be between 1 and ${MAX_GRID_CELLS}`;
  }
  if ((g.rows as number) < 1 || (g.rows as number) > rowsMax) {
    return `grid.rows must be between 1 and ${MAX_GRID_CELLS}`;
  }
  if (!inCoordRange(g.x as number) || !inCoordRange(g.y as number)) {
    return `grid.x and grid.y must be between -${MAX_COORD} and ${MAX_COORD}`;
  }
  return null;
}

function validateFreeform(obj: unknown): string | null {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return 'freeform must be an object with points and closed';
  }
  const f = obj as Record<string, unknown>;
  if (!Array.isArray(f.points)) return 'freeform.points must be an array';
  if (f.points.length < 4 || f.points.length > 2000) {
    return 'freeform.points length must be between 4 and 2000';
  }
  if (f.points.length % 2 !== 0) {
    return 'freeform.points must have an even number of elements';
  }
  if (!f.points.every((p: unknown) => typeof p === 'number' && isFinite(p))) {
    return 'freeform.points must contain only finite numbers';
  }
  if (!f.points.every((p: number) => inCoordRange(p))) {
    return `freeform.points must be between -${MAX_COORD} and ${MAX_COORD}`;
  }
  if (typeof f.closed !== 'boolean') return 'freeform.closed must be a boolean';
  return null;
}

// ── Gardens ───────────────────────────────────────────────────────────────────

// GET /api/gardens
router.get('/', async (req, res) => {
  try {
    const accountId = req.session!.account?.id ?? null;
    const sessionId = req.session!.id;
    const season = currentSeason();
    const result = await db.query<GardenListRow>(
      `SELECT ${GARDEN_SELECT},
        (SELECT COALESCE(SUM(p.quantity), 0)::int FROM plantings p
         WHERE p.garden_id = gardens.id AND p.season = $3)
         AS active_planting_count
       FROM gardens
       WHERE (owner_id = $1 OR guest_session_id = $2)
       ORDER BY last_accessed_at DESC`,
      [accountId, sessionId, season],
    );
    res.json({
      data: result.rows.map(r => ({
        ...formatGarden(r),
        activePlantingCount: r.active_planting_count,
      })),
    });
  } catch (err) {
    logger.error('GET /gardens failed', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/gardens
router.post('/', writeLimiter, async (req, res) => {
  const accountId = req.session!.account?.id ?? null;
  const sessionId = req.session!.id;
  const { name, style, zone, description, zoneLocationLabel, growingMethod } = req.body as Record<string, unknown>;

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ error: 'name is required' });
  }
  if (name.trim().length > 255) {
    return res.status(400).json({ error: 'name must be 255 characters or fewer' });
  }
  if (!style || typeof style !== 'string' || !VALID_STYLES.has(style)) {
    return res.status(400).json({
      error: `style is required and must be one of: ${[...VALID_STYLES].join(', ')}`,
    });
  }
  const zoneRes = textField(zone, { field: 'zone', max: 10, required: true });
  if (!zoneRes.ok) return res.status(400).json({ error: zoneRes.error });
  const descriptionRes = textField(description, { field: 'description', max: 2000 });
  if (!descriptionRes.ok) return res.status(400).json({ error: descriptionRes.error });
  const zoneLocationLabelRes = textField(zoneLocationLabel, { field: 'zoneLocationLabel', max: 80 });
  if (!zoneLocationLabelRes.ok) return res.status(400).json({ error: zoneLocationLabelRes.error });
  if (!growingMethod || typeof growingMethod !== 'string' || !VALID_GROWING_METHODS.has(growingMethod)) {
    return res.status(400).json({
      error: `growingMethod is required and must be one of: ${[...VALID_GROWING_METHODS].join(', ')}`,
    });
  }

  try {
    const insertSql = `INSERT INTO gardens (owner_id, guest_session_id, name, style, growing_method, zone, description, zone_location_label)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${GARDEN_SELECT}`;
    const insertValues = [
      accountId,
      accountId === null ? sessionId : null,
      name.trim(),
      style,
      growingMethod,
      zoneRes.value,
      descriptionRes.value,
      zoneLocationLabelRes.value,
    ];

    if (accountId === null) {
      // Guests get one garden. Lock the session row so two parallel creates
      // can't both pass the count check before either inserts.
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        const locked = await client.query('SELECT 1 FROM guest_sessions WHERE id = $1 FOR UPDATE', [
          sessionId,
        ]);
        if (locked.rowCount === 0) {
          // Purged between the session lookup and now (nightly cleanup).
          await client.query('ROLLBACK');
          return res.status(401).json({ error: 'Session expired' });
        }
        const { rows: limitRows } = await client.query<{ count: string }>(
          'SELECT COUNT(*)::text AS count FROM gardens WHERE guest_session_id = $1',
          [sessionId],
        );
        if (parseInt(limitRows[0].count, 10) >= 1) {
          await client.query('ROLLBACK');
          return res.status(403).json({
            error: 'Guest sessions can have one garden — create a free account for more',
            guest_limit: true,
          });
        }
        const result = await client.query<GardenRow>(insertSql, insertValues);
        await client.query('COMMIT');
        return res.status(201).json(formatGarden(result.rows[0]));
      } catch (txErr) {
        // Don't let a failed ROLLBACK (e.g. dropped connection) mask the real error.
        await client.query('ROLLBACK').catch(() => {});
        throw txErr;
      } finally {
        client.release();
      }
    }

    // Accounts: capped per account. Lock the account row so parallel creates
    // count and insert one at a time.
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const cap = await withinCap(client, {
        lockSql: 'SELECT 1 FROM accounts WHERE id = $1 FOR NO KEY UPDATE',
        countSql: 'SELECT COUNT(*)::int AS n FROM gardens WHERE owner_id = $1',
        params: [accountId],
        max: LIMITS.gardensPerAccount,
      });
      if (cap === 'missing') {
        await client.query('ROLLBACK');
        return res.status(401).json({ error: 'Account not found' });
      }
      if (cap === 'full') {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: GARDEN_CAP_ERROR });
      }
      const result = await client.query<GardenRow>(insertSql, insertValues);
      await client.query('COMMIT');
      return res.status(201).json(formatGarden(result.rows[0]));
    } catch (txErr) {
      await client.query('ROLLBACK').catch(() => {});
      throw txErr;
    } finally {
      client.release();
    }
  } catch (err) {
    logger.error('POST /gardens failed', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/gardens/:id  (includes beds filtered by season)
router.get('/:id', async (req, res) => {
  const accountId = req.session!.account?.id ?? null;
  const sessionId = req.session!.id;
  const gardenId = req.params.id as string;

  if (!isNumericId(gardenId)) return res.status(400).json({ error: 'Invalid id' });

  try {
    const gardenResult = await db.query<GardenRow>(
      `SELECT ${GARDEN_SELECT}
       FROM gardens
       WHERE id = $1 AND (owner_id = $2 OR guest_session_id = $3)`,
      [gardenId, accountId, sessionId],
    );
    if (gardenResult.rows.length === 0) {
      return res.status(404).json({ error: 'Garden not found' });
    }

    // Fire-and-forget: bump last_accessed_at so the list re-sorts on next load
    db.query('UPDATE gardens SET last_accessed_at = NOW() WHERE id = $1', [gardenId]).catch(() => {});

    let season: number;
    if (req.query.season !== undefined) {
      const parsed = validateSeason(req.query.season);
      if ('error' in parsed) return res.status(400).json({ error: parsed.error });
      season = parsed.value;
    } else {
      season = currentSeason();
    }

    const bedsResult = await db.query<BedRow>(
      `SELECT ${BED_SELECT},
       (SELECT COUNT(*)::int FROM plantings p WHERE p.bed_id = beds.id) AS planting_count
       FROM beds
       WHERE garden_id = $1 AND season = $2
       ORDER BY created_at ASC, id ASC`,
      [gardenId, season],
    );

    res.json({
      ...formatGarden(gardenResult.rows[0]),
      beds: bedsResult.rows.map(formatBed),
    });
  } catch (err) {
    logger.error('GET /gardens/:id failed', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/gardens/:id
router.patch('/:id', writeLimiter, async (req, res) => {
  const accountId = req.session!.account?.id ?? null;
  const sessionId = req.session!.id;
  const gardenId = req.params.id as string;

  if (!isNumericId(gardenId)) return res.status(400).json({ error: 'Invalid id' });

  try {
    const existing = await db.query(
      'SELECT id FROM gardens WHERE id = $1 AND (owner_id = $2 OR guest_session_id = $3)',
      [gardenId, accountId, sessionId],
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Garden not found' });
    }

    const { name, style, zone, description, zoneLocationLabel, growingMethod } = req.body as Record<string, unknown>;

    const updates: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (name !== undefined) {
      if (typeof name !== 'string' || name.trim().length === 0) {
        return res.status(400).json({ error: 'name cannot be empty' });
      }
      if (name.trim().length > 255) {
        return res.status(400).json({ error: 'name must be 255 characters or fewer' });
      }
      updates.push(`name = $${idx++}`);
      values.push(name.trim());
    }
    if (style !== undefined) {
      if (typeof style !== 'string' || !VALID_STYLES.has(style)) {
        return res.status(400).json({ error: `style must be one of: ${[...VALID_STYLES].join(', ')}` });
      }
      updates.push(`style = $${idx++}`);
      values.push(style);
    }
    if (zone !== undefined) {
      const r = textField(zone, { field: 'zone', max: 10, required: true });
      if (!r.ok) {
        return res.status(400).json({ error: r.error.endsWith('is required') ? 'zone cannot be empty' : r.error });
      }
      updates.push(`zone = $${idx++}`);
      values.push(r.value);
    }
    if (description !== undefined) {
      const r = textField(description, { field: 'description', max: 2000 });
      if (!r.ok) return res.status(400).json({ error: r.error });
      updates.push(`description = $${idx++}`);
      values.push(r.value);
    }
    if (zoneLocationLabel !== undefined) {
      const r = textField(zoneLocationLabel, { field: 'zoneLocationLabel', max: 80 });
      if (!r.ok) return res.status(400).json({ error: r.error });
      updates.push(`zone_location_label = $${idx++}`);
      values.push(r.value);
    }
    if (growingMethod !== undefined) {
      if (typeof growingMethod !== 'string' || !VALID_GROWING_METHODS.has(growingMethod)) {
        return res.status(400).json({
          error: `growingMethod must be one of: ${[...VALID_GROWING_METHODS].join(', ')}`,
        });
      }
      updates.push(`growing_method = $${idx++}`);
      values.push(growingMethod);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    updates.push(`updated_at = NOW()`);
    values.push(gardenId);

    const result = await db.query<GardenRow>(
      `UPDATE gardens SET ${updates.join(', ')}
       WHERE id = $${idx}
       RETURNING ${GARDEN_SELECT}`,
      values,
    );
    res.json(formatGarden(result.rows[0]));
  } catch (err) {
    logger.error('PATCH /gardens/:id failed', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/gardens/:id
router.delete('/:id', writeLimiter, async (req, res) => {
  const accountId = req.session!.account?.id ?? null;
  const sessionId = req.session!.id;
  const gardenId = req.params.id as string;

  if (!isNumericId(gardenId)) return res.status(400).json({ error: 'Invalid id' });

  try {
    const client = await db.connect();
    let queuedIds: number[] = [];
    try {
      await client.query('BEGIN');
      // Only an owned garden becomes a candidate, so a request can't lock
      // someone else's garden row.
      const { rows: owned } = await client.query<{ id: number }>(
        'SELECT id FROM gardens WHERE id = $1 AND (owner_id = $2 OR guest_session_id = $3)',
        [gardenId, accountId, sessionId],
      );
      const { deleted, ids } = await queueDeletedGardens(
        client,
        owned.map((r) => r.id),
        `DELETE FROM gardens WHERE id = ANY($1::int[]) AND (owner_id = $2 OR guest_session_id = $3)
         RETURNING id`,
        [accountId, sessionId],
      );
      if (deleted.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Garden not found' });
      }
      await client.query('COMMIT');
      queuedIds = ids;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    drainSoon(queuedIds);
    res.status(204).send();
  } catch (err) {
    logger.error('DELETE /gardens/:id failed', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/gardens/:id/seasons  (the current season + every season with a layout)
router.get('/:id/seasons', async (req, res) => {
  const accountId = req.session!.account?.id ?? null;
  const sessionId = req.session!.id;
  const gardenId = req.params.id as string;

  if (!isNumericId(gardenId)) return res.status(400).json({ error: 'Invalid id' });

  try {
    const garden = await db.query(
      'SELECT id FROM gardens WHERE id = $1 AND (owner_id = $2 OR guest_session_id = $3)',
      [gardenId, accountId, sessionId],
    );
    if (garden.rows.length === 0) {
      return res.status(404).json({ error: 'Garden not found' });
    }

    const result = await db.query<{ season: number }>(
      'SELECT DISTINCT season FROM beds WHERE garden_id = $1 ORDER BY season DESC',
      [gardenId],
    );
    res.json({
      currentSeason: currentSeason(),
      layoutSeasons: result.rows.map(r => r.season),
    });
  } catch (err) {
    logger.error('GET /gardens/:id/seasons failed', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/gardens/:id/thumbnail  (raw PNG body, captured from the canvas)
router.post(
  '/:id/thumbnail',
  writeLimiter,
  express.raw({ type: 'image/png', limit: '1mb' }),
  async (req, res) => {
    const accountId = req.session!.account?.id ?? null;
    const sessionId = req.session!.id;
    const gardenId = req.params.id as string;

    if (!isNumericId(gardenId)) return res.status(400).json({ error: 'Invalid id' });

    try {
      const existing = await db.query<{ thumbnail_url: string | null }>(
        'SELECT thumbnail_url FROM gardens WHERE id = $1 AND (owner_id = $2 OR guest_session_id = $3)',
        [gardenId, accountId, sessionId],
      );
      if (existing.rows.length === 0) {
        return res.status(404).json({ error: 'Garden not found' });
      }

      // A non-PNG Content-Type leaves req.body unparsed (not a Buffer).
      const body: unknown = req.body;
      if (
        !Buffer.isBuffer(body) ||
        body.length < PNG_SIGNATURE.length ||
        !body.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
      ) {
        return res.status(400).json({ error: 'Expected a PNG image.' });
      }

      // Re-encode so only decoded pixels reach storage (drops trailing data).
      let png: Buffer;
      try {
        png = await processThumbnail(body);
      } catch (err) {
        if (err instanceof ImageRejectedError) {
          return res.status(400).json({ error: 'Expected a PNG image.' });
        }
        if (err instanceof ImageBusyError) {
          return res.status(503).json({ error: 'Busy, try again.' });
        }
        throw err;
      }

      const key = `garden-thumbnails/${gardenId}/${crypto.randomUUID()}.png`;
      let url: string;
      try {
        url = await uploadToR2(key, png, 'image/png');
      } catch (err) {
        if (isR2ConfigError(err)) {
          return res.status(503).json({ error: 'Photo storage is not configured.' });
        }
        throw err;
      }

      const client = await db.connect();
      let queuedIds: number[] = [];
      try {
        await client.query('BEGIN');
        // Re-read under lock: a concurrent upload may have replaced the
        // thumbnail since the read above, and that one is what we replace.
        const current = await client.query<{ thumbnail_url: string | null }>(
          'SELECT thumbnail_url FROM gardens WHERE id = $1 FOR UPDATE',
          [gardenId],
        );
        if (current.rows.length === 0) {
          // Deleted meanwhile. Its queued folder delete covers the new upload.
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'Garden not found' });
        }
        const oldKey = ownedThumbnailKey(current.rows[0].thumbnail_url, gardenId);
        await client.query('UPDATE gardens SET thumbnail_url = $1 WHERE id = $2', [url, gardenId]);
        if (oldKey) queuedIds = await queueR2Deletions(client, [{ bucket: 'public', path: oldKey, isPrefix: false }]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
      drainSoon(queuedIds);

      res.json({ thumbnailUrl: url });
    } catch (err) {
      logger.error('POST /gardens/:id/thumbnail failed', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// ── Beds (nested under gardens) ───────────────────────────────────────────────

// GET /api/gardens/:gardenId/beds
router.get('/:gardenId/beds', async (req, res) => {
  const accountId = req.session!.account?.id ?? null;
  const sessionId = req.session!.id;
  const gardenId = req.params.gardenId as string;

  if (!isNumericId(gardenId)) return res.status(400).json({ error: 'Invalid id' });

  try {
    const garden = await db.query(
      'SELECT id FROM gardens WHERE id = $1 AND (owner_id = $2 OR guest_session_id = $3)',
      [gardenId, accountId, sessionId],
    );
    if (garden.rows.length === 0) {
      return res.status(404).json({ error: 'Garden not found' });
    }

    let season: number;
    if (req.query.season !== undefined) {
      const parsed = validateSeason(req.query.season);
      if ('error' in parsed) return res.status(400).json({ error: parsed.error });
      season = parsed.value;
    } else {
      season = currentSeason();
    }

    const result = await db.query<BedRow>(
      `SELECT ${BED_SELECT},
       (SELECT COUNT(*)::int FROM plantings p WHERE p.bed_id = beds.id) AS planting_count
       FROM beds
       WHERE garden_id = $1 AND season = $2
       ORDER BY created_at ASC, id ASC`,
      [gardenId, season],
    );
    res.json({ data: result.rows.map(formatBed) });
  } catch (err) {
    logger.error('GET /gardens/:gardenId/beds failed', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/gardens/:gardenId/beds
router.post('/:gardenId/beds', writeLimiter, async (req, res) => {
  const accountId = req.session!.account?.id ?? null;
  const sessionId = req.session!.id;
  const gardenId = req.params.gardenId as string;

  if (!isNumericId(gardenId)) return res.status(400).json({ error: 'Invalid id' });

  try {
    const garden = await db.query(
      'SELECT id FROM gardens WHERE id = $1 AND (owner_id = $2 OR guest_session_id = $3)',
      [gardenId, accountId, sessionId],
    );
    if (garden.rows.length === 0) {
      return res.status(404).json({ error: 'Garden not found' });
    }

    const { type, label, season: rawSeason, grid, freeform } = req.body as Record<string, unknown>;

    if (type !== 'grid' && type !== 'freeform') {
      return res.status(400).json({ error: "type must be 'grid' or 'freeform'" });
    }

    let season: number;
    if (rawSeason !== undefined) {
      const parsed = validateSeason(rawSeason);
      if ('error' in parsed) return res.status(400).json({ error: parsed.error });
      season = parsed.value;
    } else {
      season = currentSeason();
    }

    const labelStr = typeof label === 'string' ? label.trim() : '';
    if (labelStr.length > 255) {
      return res.status(400).json({ error: 'label must be 255 characters or fewer' });
    }

    let insertSql: string;
    let insertValues: unknown[];
    if (type === 'grid') {
      if (freeform !== undefined) {
        return res.status(400).json({ error: 'freeform must not be provided for a grid bed' });
      }
      if (grid === undefined) {
        return res.status(400).json({ error: 'grid is required for type grid' });
      }
      const gridErr = validateGrid(grid);
      if (gridErr) return res.status(400).json({ error: gridErr });

      const g = grid as Record<string, number>;
      insertSql = `INSERT INTO beds (garden_id, season, type, label, grid_x, grid_y, grid_cols, grid_rows)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING ${BED_SELECT}`;
      insertValues = [gardenId, season, 'grid', labelStr, g.x, g.y, g.cols, g.rows];
    } else {
      if (grid !== undefined) {
        return res.status(400).json({ error: 'grid must not be provided for a freeform bed' });
      }
      if (freeform === undefined) {
        return res.status(400).json({ error: 'freeform is required for type freeform' });
      }
      const freeformErr = validateFreeform(freeform);
      if (freeformErr) return res.status(400).json({ error: freeformErr });

      const f = freeform as Record<string, unknown>;
      insertSql = `INSERT INTO beds (garden_id, season, type, label, freeform_points, freeform_closed)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING ${BED_SELECT}`;
      insertValues = [gardenId, season, 'freeform', labelStr, JSON.stringify(f.points), f.closed];
    }

    // Beds are capped per garden (all seasons). Lock the garden row so
    // parallel creates count and insert one at a time.
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const cap = await withinCap(client, {
        lockSql: 'SELECT 1 FROM gardens WHERE id = $1 FOR NO KEY UPDATE',
        countSql: 'SELECT COUNT(*)::int AS n FROM beds WHERE garden_id = $1',
        params: [gardenId],
        max: LIMITS.bedsPerGarden,
      });
      if (cap === 'missing') {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Garden not found' });
      }
      if (cap === 'full') {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: BED_CAP_ERROR });
      }
      const result = await client.query<BedRow>(insertSql, insertValues);
      await client.query('COMMIT');
      return res.status(201).json(formatBed(result.rows[0]));
    } catch (txErr) {
      await client.query('ROLLBACK').catch(() => {});
      throw txErr;
    } finally {
      client.release();
    }
  } catch (err) {
    logger.error('POST /gardens/:gardenId/beds failed', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/gardens/:gardenId/beds/carry-forward
// Copies a past season's bed layout (geometry + labels, no plantings) into the
// current season. Only allowed while the current season has no beds.
router.post('/:gardenId/beds/carry-forward', writeLimiter, async (req, res) => {
  const accountId = req.session!.account?.id ?? null;
  const sessionId = req.session!.id;
  const gardenId = req.params.gardenId as string;

  if (!isNumericId(gardenId)) return res.status(400).json({ error: 'Invalid id' });

  const season = currentSeason();
  const { fromSeason: rawFromSeason } = (req.body ?? {}) as Record<string, unknown>;
  const parsedFrom = validateSeason(rawFromSeason);
  if ('error' in parsedFrom) {
    return res.status(400).json({ error: parsedFrom.error.replace(/^season/, 'fromSeason') });
  }
  const fromSeason = parsedFrom.value;
  if (fromSeason >= season) {
    return res.status(400).json({
      error: `fromSeason must be before the current season (${season})`,
    });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Lock the garden row so two concurrent carry-forwards serialise on the
    // "current season is empty" check below, and so the bed cap check can't
    // race a plain POST /beds (which takes the same lock). NO KEY UPDATE, like
    // withinCap, so it doesn't conflict with child inserts' KEY SHARE locks.
    const garden = await client.query(
      `SELECT id FROM gardens
       WHERE id = $1 AND (owner_id = $2 OR guest_session_id = $3)
       FOR NO KEY UPDATE`,
      [gardenId, accountId, sessionId],
    );
    if (garden.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Garden not found' });
    }

    const existing = await client.query(
      'SELECT 1 FROM beds WHERE garden_id = $1 AND season = $2 LIMIT 1',
      [gardenId, season],
    );
    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This season already has beds.' });
    }

    // The cap counts every season, so check the total after copying.
    const { rows: counts } = await client.query<{ total: number; copying: number }>(
      `SELECT COUNT(*)::int AS total,
              (COUNT(*) FILTER (WHERE season = $2))::int AS copying
       FROM beds WHERE garden_id = $1`,
      [gardenId, fromSeason],
    );
    if (counts[0].copying > 0 && counts[0].total + counts[0].copying > LIMITS.bedsPerGarden) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: BED_CAP_ERROR });
    }

    const result = await client.query<BedRow>(
      `INSERT INTO beds (garden_id, season, type, label, grid_x, grid_y, grid_cols, grid_rows,
                         freeform_points, freeform_closed)
       SELECT garden_id, $2, type, label, grid_x, grid_y, grid_cols, grid_rows,
              freeform_points, freeform_closed
       FROM beds
       WHERE garden_id = $1 AND season = $3
       ORDER BY created_at ASC, id ASC
       RETURNING ${BED_SELECT}`,
      [gardenId, season, fromSeason],
    );
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'No beds in that season' });
    }

    await client.query('COMMIT');
    const beds = [...result.rows].sort((a, b) => Number(a.id) - Number(b.id));
    res.status(201).json({ data: beds.map(formatBed) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('POST /gardens/:gardenId/beds/carry-forward failed', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// PATCH /api/gardens/:gardenId/beds/:bedId
router.patch('/:gardenId/beds/:bedId', writeLimiter, async (req, res) => {
  const accountId = req.session!.account?.id ?? null;
  const sessionId = req.session!.id;
  const gardenId = req.params.gardenId as string;
  const bedId = req.params.bedId as string;

  if (!isNumericId(gardenId)) return res.status(400).json({ error: 'Invalid id' });
  if (!isNumericId(bedId)) return res.status(400).json({ error: 'Invalid id' });

  try {
    const garden = await db.query(
      'SELECT id FROM gardens WHERE id = $1 AND (owner_id = $2 OR guest_session_id = $3)',
      [gardenId, accountId, sessionId],
    );
    if (garden.rows.length === 0) {
      return res.status(404).json({ error: 'Garden not found' });
    }

    const bedResult = await db.query<{
      id: string;
      type: 'grid' | 'freeform';
      grid_cols: number | null;
      grid_rows: number | null;
    }>(
      'SELECT id::text, type, grid_cols, grid_rows FROM beds WHERE id = $1 AND garden_id = $2',
      [bedId, gardenId],
    );
    if (bedResult.rows.length === 0) {
      return res.status(404).json({ error: 'Bed not found' });
    }
    const currentType = bedResult.rows[0].type;
    const storedGrid = { cols: bedResult.rows[0].grid_cols, rows: bedResult.rows[0].grid_rows };

    const body = req.body as Record<string, unknown>;

    if (body.season !== undefined) {
      return res.status(400).json({ error: 'season cannot be changed' });
    }

    const updates: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (body.label !== undefined) {
      const labelStr = typeof body.label === 'string' ? body.label.trim() : '';
      if (labelStr.length > 255) {
        return res.status(400).json({ error: 'label must be 255 characters or fewer' });
      }
      updates.push(`label = $${idx++}`);
      values.push(labelStr);
    }

    const newType = body.type as 'grid' | 'freeform' | undefined;

    if (newType !== undefined && newType !== 'grid' && newType !== 'freeform') {
      return res.status(400).json({ error: "type must be 'grid' or 'freeform'" });
    }

    if (newType !== undefined && newType !== currentType) {
      // Type conversion — full geometry for the new type is required
      if (newType === 'grid') {
        if (body.freeform !== undefined) {
          return res.status(400).json({ error: 'freeform must not be provided when switching to grid' });
        }
        if (body.grid === undefined) {
          return res.status(400).json({ error: 'grid is required when changing type to grid' });
        }
        const gridErr = validateGrid(body.grid);
        if (gridErr) return res.status(400).json({ error: gridErr });
        const g = body.grid as Record<string, number>;
        updates.push(`type = $${idx++}`);        values.push('grid');
        updates.push(`grid_x = $${idx++}`);      values.push(g.x);
        updates.push(`grid_y = $${idx++}`);      values.push(g.y);
        updates.push(`grid_cols = $${idx++}`);   values.push(g.cols);
        updates.push(`grid_rows = $${idx++}`);   values.push(g.rows);
        updates.push(`freeform_points = $${idx++}`);  values.push(null);
        updates.push(`freeform_closed = $${idx++}`);  values.push(null);
      } else {
        // Switching to freeform
        if (body.grid !== undefined) {
          return res.status(400).json({ error: 'grid must not be provided when switching to freeform' });
        }
        if (body.freeform === undefined) {
          return res.status(400).json({ error: 'freeform is required when changing type to freeform' });
        }
        const freeformErr = validateFreeform(body.freeform);
        if (freeformErr) return res.status(400).json({ error: freeformErr });
        const f = body.freeform as Record<string, unknown>;
        updates.push(`type = $${idx++}`);              values.push('freeform');
        updates.push(`freeform_points = $${idx++}`);   values.push(JSON.stringify(f.points));
        updates.push(`freeform_closed = $${idx++}`);   values.push(f.closed);
        updates.push(`grid_x = $${idx++}`);            values.push(null);
        updates.push(`grid_y = $${idx++}`);            values.push(null);
        updates.push(`grid_cols = $${idx++}`);         values.push(null);
        updates.push(`grid_rows = $${idx++}`);         values.push(null);
      }
    } else {
      // No type change — geometry update if provided must match current type
      const effectiveType = newType ?? currentType;

      if (body.grid !== undefined) {
        if (effectiveType !== 'grid') {
          return res.status(400).json({ error: 'grid geometry does not match bed type' });
        }
        const gridErr = validateGrid(body.grid, storedGrid);
        if (gridErr) return res.status(400).json({ error: gridErr });
        const g = body.grid as Record<string, number>;
        updates.push(`grid_x = $${idx++}`);    values.push(g.x);
        updates.push(`grid_y = $${idx++}`);    values.push(g.y);
        updates.push(`grid_cols = $${idx++}`); values.push(g.cols);
        updates.push(`grid_rows = $${idx++}`); values.push(g.rows);
      }

      if (body.freeform !== undefined) {
        if (effectiveType !== 'freeform') {
          return res.status(400).json({ error: 'freeform geometry does not match bed type' });
        }
        const freeformErr = validateFreeform(body.freeform);
        if (freeformErr) return res.status(400).json({ error: freeformErr });
        const f = body.freeform as Record<string, unknown>;
        updates.push(`freeform_points = $${idx++}`); values.push(JSON.stringify(f.points));
        updates.push(`freeform_closed = $${idx++}`); values.push(f.closed);
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    updates.push(`updated_at = NOW()`);
    values.push(bedId);

    const result = await db.query<BedRow>(
      `UPDATE beds SET ${updates.join(', ')}
       WHERE id = $${idx}
       RETURNING ${BED_SELECT}`,
      values,
    );
    res.json(formatBed(result.rows[0]));
  } catch (err) {
    logger.error('PATCH /gardens/:gardenId/beds/:bedId failed', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/gardens/:gardenId/beds/:bedId
router.delete('/:gardenId/beds/:bedId', writeLimiter, async (req, res) => {
  const accountId = req.session!.account?.id ?? null;
  const sessionId = req.session!.id;
  const gardenId = req.params.gardenId as string;
  const bedId = req.params.bedId as string;

  if (!isNumericId(gardenId)) return res.status(400).json({ error: 'Invalid id' });
  if (!isNumericId(bedId)) return res.status(400).json({ error: 'Invalid id' });

  try {
    const garden = await db.query(
      'SELECT id FROM gardens WHERE id = $1 AND (owner_id = $2 OR guest_session_id = $3)',
      [gardenId, accountId, sessionId],
    );
    if (garden.rows.length === 0) {
      return res.status(404).json({ error: 'Garden not found' });
    }

    const result = await db.query(
      'DELETE FROM beds WHERE id = $1 AND garden_id = $2 RETURNING id',
      [bedId, gardenId],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Bed not found' });
    }
    res.status(204).send();
  } catch (err) {
    logger.error('DELETE /gardens/:gardenId/beds/:bedId failed', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;

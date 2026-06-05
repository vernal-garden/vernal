import { Router } from 'express';
import { db } from '../lib/db';
import { requireAuth } from '../middleware/auth';

const router = Router();
router.use(requireAuth);

// ── Type helpers ──────────────────────────────────────────────────────────────

interface GardenRow {
  id: string;
  owner_id: string;
  name: string;
  style: string;
  description: string | null;
  zone: string;
  zone_location_label: string | null;
  created_at: string;
  updated_at: string;
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
  id::text, owner_id::text, name, style, description, zone, zone_location_label,
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
    description: row.description,
    zone: row.zone,
    zoneLocationLabel: row.zone_location_label,
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

const VALID_STYLES = new Set(['grid', 'freeform', 'mixed']);

// ── Validation helpers ────────────────────────────────────────────────────────

function validateSeason(v: unknown): { value: number } | { error: string } {
  const n = typeof v === 'string' ? parseInt(v, 10) : v;
  if (!Number.isInteger(n) || (n as number) < 2000 || (n as number) > 2100) {
    return { error: 'season must be an integer between 2000 and 2100' };
  }
  return { value: n as number };
}

function validateGrid(obj: unknown): string | null {
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
  if ((g.cols as number) < 1 || (g.cols as number) > 1000) {
    return 'grid.cols must be between 1 and 1000';
  }
  if ((g.rows as number) < 1 || (g.rows as number) > 1000) {
    return 'grid.rows must be between 1 and 1000';
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
  if (typeof f.closed !== 'boolean') return 'freeform.closed must be a boolean';
  return null;
}

// ── Gardens ───────────────────────────────────────────────────────────────────

// GET /api/gardens
router.get('/', async (req, res) => {
  try {
    const accountId = req.session!.account!.id;
    const result = await db.query<GardenRow>(
      `SELECT ${GARDEN_SELECT}
       FROM gardens
       WHERE owner_id = $1
       ORDER BY created_at ASC`,
      [accountId],
    );
    res.json({ data: result.rows.map(formatGarden) });
  } catch (err) {
    console.error('GET /gardens error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/gardens
router.post('/', async (req, res) => {
  const accountId = req.session!.account!.id;
  const { name, style, zone, description, zoneLocationLabel } = req.body as Record<string, unknown>;

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
  if (!zone || typeof zone !== 'string' || zone.trim().length === 0) {
    return res.status(400).json({ error: 'zone is required' });
  }

  try {
    const result = await db.query<GardenRow>(
      `INSERT INTO gardens (owner_id, name, style, zone, description, zone_location_label)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${GARDEN_SELECT}`,
      [
        accountId,
        name.trim(),
        style,
        zone.trim(),
        typeof description === 'string' ? description.trim() || null : null,
        typeof zoneLocationLabel === 'string' ? zoneLocationLabel.trim() || null : null,
      ],
    );
    res.status(201).json(formatGarden(result.rows[0]));
  } catch (err) {
    console.error('POST /gardens error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/gardens/:id  (includes beds filtered by season)
router.get('/:id', async (req, res) => {
  const accountId = req.session!.account!.id;
  const gardenId = req.params.id as string;

  try {
    const gardenResult = await db.query<GardenRow>(
      `SELECT ${GARDEN_SELECT}
       FROM gardens
       WHERE id = $1 AND owner_id = $2`,
      [gardenId, accountId],
    );
    if (gardenResult.rows.length === 0) {
      return res.status(404).json({ error: 'Garden not found' });
    }

    let season: number;
    if (req.query.season !== undefined) {
      const parsed = validateSeason(req.query.season);
      if ('error' in parsed) return res.status(400).json({ error: parsed.error });
      season = parsed.value;
    } else {
      season = new Date().getFullYear();
    }

    const bedsResult = await db.query<BedRow>(
      `SELECT ${BED_SELECT},
       (SELECT COUNT(*)::int FROM plantings p WHERE p.bed_id = beds.id) AS planting_count
       FROM beds
       WHERE garden_id = $1 AND season = $2
       ORDER BY created_at ASC`,
      [gardenId, season],
    );

    res.json({
      ...formatGarden(gardenResult.rows[0]),
      beds: bedsResult.rows.map(formatBed),
    });
  } catch (err) {
    console.error('GET /gardens/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/gardens/:id
router.patch('/:id', async (req, res) => {
  const accountId = req.session!.account!.id;
  const gardenId = req.params.id as string;

  try {
    const existing = await db.query(
      'SELECT id FROM gardens WHERE id = $1 AND owner_id = $2',
      [gardenId, accountId],
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Garden not found' });
    }

    const { name, style, zone, description, zoneLocationLabel } = req.body as Record<string, unknown>;

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
      if (typeof zone !== 'string' || zone.trim().length === 0) {
        return res.status(400).json({ error: 'zone cannot be empty' });
      }
      updates.push(`zone = $${idx++}`);
      values.push(zone.trim());
    }
    if (description !== undefined) {
      updates.push(`description = $${idx++}`);
      values.push(typeof description === 'string' ? description.trim() || null : null);
    }
    if (zoneLocationLabel !== undefined) {
      updates.push(`zone_location_label = $${idx++}`);
      values.push(typeof zoneLocationLabel === 'string' ? zoneLocationLabel.trim() || null : null);
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
    console.error('PATCH /gardens/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/gardens/:id
router.delete('/:id', async (req, res) => {
  const accountId = req.session!.account!.id;
  const gardenId = req.params.id as string;

  try {
    const result = await db.query(
      'DELETE FROM gardens WHERE id = $1 AND owner_id = $2 RETURNING id',
      [gardenId, accountId],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Garden not found' });
    }
    res.status(204).send();
  } catch (err) {
    console.error('DELETE /gardens/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Beds (nested under gardens) ───────────────────────────────────────────────

// GET /api/gardens/:gardenId/beds
router.get('/:gardenId/beds', async (req, res) => {
  const accountId = req.session!.account!.id;
  const gardenId = req.params.gardenId as string;

  try {
    const garden = await db.query(
      'SELECT id FROM gardens WHERE id = $1 AND owner_id = $2',
      [gardenId, accountId],
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
      season = new Date().getFullYear();
    }

    const result = await db.query<BedRow>(
      `SELECT ${BED_SELECT},
       (SELECT COUNT(*)::int FROM plantings p WHERE p.bed_id = beds.id) AS planting_count
       FROM beds
       WHERE garden_id = $1 AND season = $2
       ORDER BY created_at ASC`,
      [gardenId, season],
    );
    res.json({ data: result.rows.map(formatBed) });
  } catch (err) {
    console.error('GET /gardens/:gardenId/beds error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/gardens/:gardenId/beds
router.post('/:gardenId/beds', async (req, res) => {
  const accountId = req.session!.account!.id;
  const gardenId = req.params.gardenId as string;

  try {
    const garden = await db.query(
      'SELECT id FROM gardens WHERE id = $1 AND owner_id = $2',
      [gardenId, accountId],
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
      season = new Date().getFullYear();
    }

    const labelStr = typeof label === 'string' ? label.trim() : '';
    if (labelStr.length > 255) {
      return res.status(400).json({ error: 'label must be 255 characters or fewer' });
    }

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
      const result = await db.query<BedRow>(
        `INSERT INTO beds (garden_id, season, type, label, grid_x, grid_y, grid_cols, grid_rows)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING ${BED_SELECT}`,
        [gardenId, season, 'grid', labelStr, g.x, g.y, g.cols, g.rows],
      );
      return res.status(201).json(formatBed(result.rows[0]));
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
      const result = await db.query<BedRow>(
        `INSERT INTO beds (garden_id, season, type, label, freeform_points, freeform_closed)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING ${BED_SELECT}`,
        [gardenId, season, 'freeform', labelStr, JSON.stringify(f.points), f.closed],
      );
      return res.status(201).json(formatBed(result.rows[0]));
    }
  } catch (err) {
    console.error('POST /gardens/:gardenId/beds error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/gardens/:gardenId/beds/:bedId
router.patch('/:gardenId/beds/:bedId', async (req, res) => {
  const accountId = req.session!.account!.id;
  const gardenId = req.params.gardenId as string;
  const bedId = req.params.bedId as string;

  try {
    const garden = await db.query(
      'SELECT id FROM gardens WHERE id = $1 AND owner_id = $2',
      [gardenId, accountId],
    );
    if (garden.rows.length === 0) {
      return res.status(404).json({ error: 'Garden not found' });
    }

    const bedResult = await db.query<{ id: string; type: 'grid' | 'freeform' }>(
      'SELECT id::text, type FROM beds WHERE id = $1 AND garden_id = $2',
      [bedId, gardenId],
    );
    if (bedResult.rows.length === 0) {
      return res.status(404).json({ error: 'Bed not found' });
    }
    const currentType = bedResult.rows[0].type;

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
        const gridErr = validateGrid(body.grid);
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
    console.error('PATCH /gardens/:gardenId/beds/:bedId error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/gardens/:gardenId/beds/:bedId
router.delete('/:gardenId/beds/:bedId', async (req, res) => {
  const accountId = req.session!.account!.id;
  const gardenId = req.params.gardenId as string;
  const bedId = req.params.bedId as string;

  try {
    const garden = await db.query(
      'SELECT id FROM gardens WHERE id = $1 AND owner_id = $2',
      [gardenId, accountId],
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
    console.error('DELETE /gardens/:gardenId/beds/:bedId error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;

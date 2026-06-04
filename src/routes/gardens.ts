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
  name: string;
  bed_type: string;
  width_cm: string | null;
  length_cm: string | null;
  depth_cm: string | null;
  notes: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

// Column lists kept as constants so any future schema change is one edit.
const GARDEN_SELECT = `
  id::text, owner_id::text, name, style, description, zone, zone_location_label,
  created_at, updated_at
`;

const BED_SELECT = `
  id::text, garden_id::text, name, bed_type, width_cm, length_cm, depth_cm,
  notes, sort_order, created_at, updated_at
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
    name: row.name,
    bedType: row.bed_type,
    widthCm: row.width_cm != null ? Number(row.width_cm) : null,
    lengthCm: row.length_cm != null ? Number(row.length_cm) : null,
    depthCm: row.depth_cm != null ? Number(row.depth_cm) : null,
    notes: row.notes,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const VALID_BED_TYPES = new Set(['raised_bed', 'row', 'container', 'in_ground', 'vertical']);
const VALID_STYLES = new Set(['grid', 'freeform', 'mixed']);

// ── Gardens ───────────────────────────────────────────────────────────────────

// GET /api/gardens
router.get('/gardens', async (req, res) => {
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
router.post('/gardens', async (req, res) => {
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

// GET /api/gardens/:id  (includes beds)
router.get('/gardens/:id', async (req, res) => {
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

    const bedsResult = await db.query<BedRow>(
      `SELECT ${BED_SELECT}
       FROM garden_beds
       WHERE garden_id = $1
       ORDER BY sort_order ASC, created_at ASC`,
      [gardenId],
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
router.patch('/gardens/:id', async (req, res) => {
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
router.delete('/gardens/:id', async (req, res) => {
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
router.get('/gardens/:gardenId/beds', async (req, res) => {
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

    const result = await db.query<BedRow>(
      `SELECT ${BED_SELECT}
       FROM garden_beds
       WHERE garden_id = $1
       ORDER BY sort_order ASC, created_at ASC`,
      [gardenId],
    );
    res.json({ data: result.rows.map(formatBed) });
  } catch (err) {
    console.error('GET /gardens/:gardenId/beds error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/gardens/:gardenId/beds
router.post('/gardens/:gardenId/beds', async (req, res) => {
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

    const { name, bedType = 'raised_bed', widthCm, lengthCm, depthCm, notes } =
      req.body as Record<string, unknown>;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ error: 'name is required' });
    }
    if (typeof bedType === 'string' && !VALID_BED_TYPES.has(bedType)) {
      return res.status(400).json({
        error: `bedType must be one of: ${[...VALID_BED_TYPES].join(', ')}`,
      });
    }

    const countResult = await db.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM garden_beds WHERE garden_id = $1',
      [gardenId],
    );
    const sortOrder = parseInt(countResult.rows[0].count, 10);

    const result = await db.query<BedRow>(
      `INSERT INTO garden_beds
         (garden_id, name, bed_type, width_cm, length_cm, depth_cm, notes, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${BED_SELECT}`,
      [
        gardenId,
        name.trim(),
        bedType,
        typeof widthCm === 'number' ? widthCm : null,
        typeof lengthCm === 'number' ? lengthCm : null,
        typeof depthCm === 'number' ? depthCm : null,
        typeof notes === 'string' ? notes.trim() || null : null,
        sortOrder,
      ],
    );
    res.status(201).json(formatBed(result.rows[0]));
  } catch (err) {
    console.error('POST /gardens/:gardenId/beds error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/gardens/:gardenId/beds/:bedId
router.patch('/gardens/:gardenId/beds/:bedId', async (req, res) => {
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

    const existing = await db.query(
      'SELECT id FROM garden_beds WHERE id = $1 AND garden_id = $2',
      [bedId, gardenId],
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Bed not found' });
    }

    const { name, bedType, widthCm, lengthCm, depthCm, notes } =
      req.body as Record<string, unknown>;

    const updates: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (name !== undefined) {
      if (typeof name !== 'string' || name.trim().length === 0) {
        return res.status(400).json({ error: 'name cannot be empty' });
      }
      updates.push(`name = $${idx++}`);
      values.push((name as string).trim());
    }
    if (bedType !== undefined) {
      if (!VALID_BED_TYPES.has(bedType as string)) {
        return res.status(400).json({
          error: `bedType must be one of: ${[...VALID_BED_TYPES].join(', ')}`,
        });
      }
      updates.push(`bed_type = $${idx++}`);
      values.push(bedType);
    }
    if (widthCm !== undefined)  { updates.push(`width_cm = $${idx++}`);  values.push(widthCm ?? null); }
    if (lengthCm !== undefined) { updates.push(`length_cm = $${idx++}`); values.push(lengthCm ?? null); }
    if (depthCm !== undefined)  { updates.push(`depth_cm = $${idx++}`);  values.push(depthCm ?? null); }
    if (notes !== undefined) {
      updates.push(`notes = $${idx++}`);
      values.push(typeof notes === 'string' ? notes.trim() || null : null);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    updates.push(`updated_at = NOW()`);
    values.push(bedId);

    const result = await db.query<BedRow>(
      `UPDATE garden_beds SET ${updates.join(', ')}
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
router.delete('/gardens/:gardenId/beds/:bedId', async (req, res) => {
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
      'DELETE FROM garden_beds WHERE id = $1 AND garden_id = $2 RETURNING id',
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

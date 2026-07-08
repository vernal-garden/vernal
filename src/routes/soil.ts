import { Router, Request, Response } from 'express';
import { db } from '../lib/db';
import { requireAuth, requireSupporter } from '../middleware/auth';

export const soilNestedRouter = Router({ mergeParams: true }); // /api/gardens/:gardenId/soil-readings
export const soilFlatRouter   = Router({ mergeParams: true }); // /api/soil-readings/:id

soilNestedRouter.use(requireAuth, requireSupporter);
soilFlatRouter.use(requireAuth, requireSupporter);

// ── Types ─────────────────────────────────────────────────────────────────────

interface SoilRow {
  id: string;
  user_id: string;
  garden_id: string;
  bed_id: string;
  test_date: string;
  ph: string | null;        // NUMERIC returns as string from pg
  nitrogen_ppm: number | null;
  phosphorus_ppm: number | null;
  potassium_ppm: number | null;
  notes: string | null;
  created_at: string;
}

// ── Formatter ────────────────────────────────────────────────────────────────

function formatReading(row: SoilRow) {
  return {
    id: row.id,
    gardenId: row.garden_id,
    bedId: row.bed_id,
    testDate: row.test_date,
    ph: row.ph !== null ? Number(row.ph) : null,
    nitrogen: row.nitrogen_ppm ?? null,
    phosphorus: row.phosphorus_ppm ?? null,
    potassium: row.potassium_ppm ?? null,
    notes: row.notes ?? null,
    createdAt: row.created_at,
  };
}

// ── Validators ────────────────────────────────────────────────────────────────

const DIGITS_RE = /^\d+$/;
const DATE_RE   = /^\d{4}-\d{2}-\d{2}$/;

// ── GET /api/gardens/:gardenId/soil-readings ──────────────────────────────────

soilNestedRouter.get('/', async (req: Request, res: Response): Promise<void> => {
  const accountId = req.session!.account!.id;
  const gardenId  = req.params.gardenId as string;

  if (!DIGITS_RE.test(gardenId)) {
    res.status(404).json({ error: 'Garden not found' });
    return;
  }

  try {
    const gRes = await db.query<{ id: string }>(
      'SELECT id FROM gardens WHERE id = $1 AND owner_id = $2',
      [gardenId, accountId],
    );
    if (gRes.rowCount === 0) {
      res.status(404).json({ error: 'Garden not found' });
      return;
    }

    const { rows } = await db.query<SoilRow>(
      `SELECT id::text, user_id::text, garden_id::text, bed_id::text,
              test_date::text, ph, nitrogen_ppm, phosphorus_ppm,
              potassium_ppm, notes, created_at
         FROM soil_readings
        WHERE garden_id = $1 AND user_id = $2
        ORDER BY test_date DESC, created_at DESC`,
      [gardenId, accountId],
    );

    res.json({ data: rows.map(formatReading) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/gardens/:gardenId/soil-readings ─────────────────────────────────

soilNestedRouter.post('/', async (req: Request, res: Response): Promise<void> => {
  const accountId = req.session!.account!.id;
  const gardenId  = req.params.gardenId as string;

  if (!DIGITS_RE.test(gardenId)) {
    res.status(404).json({ error: 'Garden not found' });
    return;
  }

  const { bedId, testDate, ph, nitrogen, phosphorus, potassium, notes } =
    req.body as Record<string, unknown>;

  if (!bedId || !DIGITS_RE.test(String(bedId))) {
    res.status(400).json({ error: 'bedId is required and must be a positive integer' });
    return;
  }
  if (!testDate || !DATE_RE.test(String(testDate))) {
    res.status(400).json({ error: 'testDate is required (YYYY-MM-DD)' });
    return;
  }
  if (ph === undefined || ph === null || ph === '') {
    res.status(400).json({ error: 'ph is required' });
    return;
  }
  const phNum = Number(ph);
  if (isNaN(phNum) || phNum < 0 || phNum > 14) {
    res.status(400).json({ error: 'ph must be between 0 and 14' });
    return;
  }

  const nitrogenVal   = nitrogen   != null && nitrogen   !== '' ? Number(nitrogen)   : null;
  const phosphorusVal = phosphorus != null && phosphorus !== '' ? Number(phosphorus) : null;
  const potassiumVal  = potassium  != null && potassium  !== '' ? Number(potassium)  : null;
  const notesVal      = notes      != null && notes      !== '' ? String(notes)      : null;

  try {
    const gRes = await db.query<{ id: string }>(
      'SELECT id FROM gardens WHERE id = $1 AND owner_id = $2',
      [gardenId, accountId],
    );
    if (gRes.rowCount === 0) {
      res.status(404).json({ error: 'Garden not found' });
      return;
    }

    const bRes = await db.query<{ id: string }>(
      'SELECT id FROM beds WHERE id = $1 AND garden_id = $2',
      [bedId, gardenId],
    );
    if (bRes.rowCount === 0) {
      res.status(400).json({ error: 'Bed not found in this garden' });
      return;
    }

    const { rows } = await db.query<SoilRow>(
      `INSERT INTO soil_readings
         (user_id, garden_id, bed_id, test_date, ph,
          nitrogen_ppm, phosphorus_ppm, potassium_ppm, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id::text, user_id::text, garden_id::text, bed_id::text,
                 test_date::text, ph, nitrogen_ppm, phosphorus_ppm,
                 potassium_ppm, notes, created_at`,
      [accountId, gardenId, bedId, testDate, phNum,
       nitrogenVal, phosphorusVal, potassiumVal, notesVal],
    );

    res.status(201).json(formatReading(rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── PATCH /api/soil-readings/:id ──────────────────────────────────────────────

soilFlatRouter.patch('/:id', async (req: Request, res: Response): Promise<void> => {
  const accountId = req.session!.account!.id;
  const readingId = req.params.id as string;

  if (!DIGITS_RE.test(readingId)) {
    res.status(404).json({ error: 'Reading not found' });
    return;
  }

  const { testDate, ph, nitrogen, phosphorus, potassium, notes, bedId } =
    req.body as Record<string, unknown>;

  // Validate before touching DB
  if (testDate !== undefined && !DATE_RE.test(String(testDate))) {
    res.status(400).json({ error: 'testDate must be YYYY-MM-DD' });
    return;
  }
  let phNum: number | undefined;
  if (ph !== undefined) {
    phNum = Number(ph);
    if (isNaN(phNum) || phNum < 0 || phNum > 14) {
      res.status(400).json({ error: 'ph must be between 0 and 14' });
      return;
    }
  }
  if (bedId !== undefined && !DIGITS_RE.test(String(bedId))) {
    res.status(400).json({ error: 'bedId must be a positive integer' });
    return;
  }

  // Collect scalar updates
  const updates: Record<string, unknown> = {};
  if (testDate   !== undefined) updates['test_date']     = testDate;
  if (phNum      !== undefined) updates['ph']            = phNum;
  if (nitrogen   !== undefined) updates['nitrogen_ppm']   = nitrogen   !== null ? Number(nitrogen)   : null;
  if (phosphorus !== undefined) updates['phosphorus_ppm'] = phosphorus !== null ? Number(phosphorus) : null;
  if (potassium  !== undefined) updates['potassium_ppm']  = potassium  !== null ? Number(potassium)  : null;
  if (notes      !== undefined) updates['notes']          = notes      !== null ? String(notes)      : null;

  const hasBedId = bedId !== undefined;

  if (Object.keys(updates).length === 0 && !hasBedId) {
    res.status(400).json({ error: 'No fields to update' });
    return;
  }

  try {
    // Verify ownership and get garden_id for bed check
    const rRes = await db.query<{ garden_id: string }>(
      'SELECT garden_id::text FROM soil_readings WHERE id = $1 AND user_id = $2',
      [readingId, accountId],
    );
    if (rRes.rowCount === 0) {
      res.status(404).json({ error: 'Reading not found' });
      return;
    }
    const gardenId = rRes.rows[0].garden_id;

    if (hasBedId) {
      const bRes = await db.query<{ id: string }>(
        'SELECT id FROM beds WHERE id = $1 AND garden_id = $2',
        [bedId, gardenId],
      );
      if (bRes.rowCount === 0) {
        res.status(400).json({ error: 'Bed not found in this garden' });
        return;
      }
      updates['bed_id'] = bedId;
    }

    // Build parameterised SET clause (no updated_at — column does not exist)
    const cols = Object.keys(updates);
    const sets = cols.map((col, i) => `${col} = $${i + 1}`);
    const vals: unknown[] = [...cols.map(c => updates[c]), readingId, accountId];
    const n = cols.length;

    const { rows } = await db.query<SoilRow>(
      `UPDATE soil_readings
          SET ${sets.join(', ')}
        WHERE id = $${n + 1} AND user_id = $${n + 2}
        RETURNING id::text, user_id::text, garden_id::text, bed_id::text,
                  test_date::text, ph, nitrogen_ppm, phosphorus_ppm,
                  potassium_ppm, notes, created_at`,
      vals,
    );

    res.json(formatReading(rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── DELETE /api/soil-readings/:id ─────────────────────────────────────────────

soilFlatRouter.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  const accountId = req.session!.account!.id;
  const readingId = req.params.id as string;

  if (!DIGITS_RE.test(readingId)) {
    res.status(404).json({ error: 'Reading not found' });
    return;
  }

  try {
    const { rowCount } = await db.query(
      'DELETE FROM soil_readings WHERE id = $1 AND user_id = $2 RETURNING id',
      [readingId, accountId],
    );
    if (rowCount === 0) {
      res.status(404).json({ error: 'Reading not found' });
      return;
    }
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

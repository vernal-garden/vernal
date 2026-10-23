import { Router, Request, Response } from 'express';
import { db } from '../lib/db';
import { logger } from '../lib/logger';
import { requireAuth, requireSupporter } from '../middleware/auth';
import { isNumericId, isRealDate, numberField, textField } from '../lib/validation';
import { writeLimiter } from '../middleware/rateLimiters';
import { LIMITS, withinCap } from '../lib/limits';
import { invalidateMetrics } from '../lib/metricsCache';

export const soilNestedRouter = Router({ mergeParams: true }); // /api/gardens/:gardenId/soil-readings
export const soilFlatRouter   = Router({ mergeParams: true }); // /api/soil-readings/:id

soilNestedRouter.use(requireAuth);
soilFlatRouter.use(requireAuth);

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

const DATE_RE   = /^\d{4}-\d{2}-\d{2}$/;
const PH_OPTS   = { field: 'ph', min: 0, max: 14 };
// N/P/K columns are INTEGER, so fractions are a 400 rather than a cast error.
const PPM_RANGE = { min: 0, max: 100000, integer: true };
const NOTES_MAX = 2000;

// ── GET /api/gardens/:gardenId/soil-readings ──────────────────────────────────

soilNestedRouter.get('/', async (req: Request, res: Response): Promise<void> => {
  const accountId = req.session!.account!.id;
  const gardenId  = req.params.gardenId as string;

  if (!isNumericId(gardenId)) {
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
    logger.error('GET /gardens/:gardenId/soil-readings failed', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/gardens/:gardenId/soil-readings ─────────────────────────────────

soilNestedRouter.post('/', requireSupporter, writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const accountId = req.session!.account!.id;
  const gardenId  = req.params.gardenId as string;

  if (!isNumericId(gardenId)) {
    res.status(404).json({ error: 'Garden not found' });
    return;
  }

  const { bedId, testDate, ph, nitrogen, phosphorus, potassium, notes } =
    req.body as Record<string, unknown>;

  if (!bedId || !isNumericId(String(bedId))) {
    res.status(400).json({ error: 'bedId is required and must be a positive integer' });
    return;
  }
  if (!testDate || !DATE_RE.test(String(testDate))) {
    res.status(400).json({ error: 'testDate is required (YYYY-MM-DD)' });
    return;
  }
  if (!isRealDate(testDate)) {
    res.status(400).json({ error: 'testDate must be a valid date' });
    return;
  }
  if (ph === undefined || ph === null || ph === '') {
    res.status(400).json({ error: 'ph is required' });
    return;
  }
  const phRes = numberField(ph, PH_OPTS);
  if (!phRes.ok) {
    res.status(400).json({ error: phRes.error });
    return;
  }
  const phNum = phRes.value as number;

  const nitrogenRes   = numberField(nitrogen,   { field: 'nitrogen',   ...PPM_RANGE });
  const phosphorusRes = numberField(phosphorus, { field: 'phosphorus', ...PPM_RANGE });
  const potassiumRes  = numberField(potassium,  { field: 'potassium',  ...PPM_RANGE });
  const notesRes      = textField(notes, { field: 'notes', max: NOTES_MAX });
  for (const r of [nitrogenRes, phosphorusRes, potassiumRes, notesRes]) {
    if (!r.ok) {
      res.status(400).json({ error: r.error });
      return;
    }
  }
  const nitrogenVal   = nitrogenRes.ok   ? nitrogenRes.value   : null;
  const phosphorusVal = phosphorusRes.ok ? phosphorusRes.value : null;
  const potassiumVal  = potassiumRes.ok  ? potassiumRes.value  : null;
  const notesVal      = notesRes.ok      ? notesRes.value      : null;

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const gRes = await client.query<{ id: string }>(
      'SELECT id FROM gardens WHERE id = $1 AND owner_id = $2',
      [gardenId, accountId],
    );
    if (gRes.rowCount === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Garden not found' });
      return;
    }

    const bRes = await client.query<{ id: string }>(
      'SELECT id FROM beds WHERE id = $1 AND garden_id = $2',
      [bedId, gardenId],
    );
    if (bRes.rowCount === 0) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: 'Bed not found in this garden' });
      return;
    }

    // Lock the garden row so parallel creates count and insert one at a time.
    const cap = await withinCap(client, {
      lockSql: 'SELECT 1 FROM gardens WHERE id = $1 FOR NO KEY UPDATE',
      countSql: 'SELECT COUNT(*)::int AS n FROM soil_readings WHERE garden_id = $1',
      params: [gardenId],
      max: LIMITS.soilReadingsPerGarden,
    });
    if (cap === 'missing') {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Garden not found' });
      return;
    }
    if (cap === 'full') {
      await client.query('ROLLBACK');
      res.status(409).json({
        error: `A garden can have up to ${LIMITS.soilReadingsPerGarden} soil readings.`,
      });
      return;
    }

    const { rows } = await client.query<SoilRow>(
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
    await client.query('COMMIT');

    invalidateMetrics(accountId);
    res.status(201).json(formatReading(rows[0]));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('POST /gardens/:gardenId/soil-readings failed', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ── PATCH /api/soil-readings/:id ──────────────────────────────────────────────

soilFlatRouter.patch('/:id', requireSupporter, writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const accountId = req.session!.account!.id;
  const readingId = req.params.id as string;

  if (!isNumericId(readingId)) {
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
  if (testDate !== undefined && !isRealDate(testDate)) {
    res.status(400).json({ error: 'testDate must be a valid date' });
    return;
  }
  let phNum: number | undefined;
  if (ph !== undefined) {
    // ph is NOT NULL: null/blank is an error here, not "absent".
    const phRes = numberField(ph, PH_OPTS);
    if (!phRes.ok || phRes.value === null) {
      res.status(400).json({ error: `ph must be a number between ${PH_OPTS.min} and ${PH_OPTS.max}` });
      return;
    }
    phNum = phRes.value;
  }
  if (bedId !== undefined && !isNumericId(String(bedId))) {
    res.status(400).json({ error: 'bedId must be a positive integer' });
    return;
  }

  // Collect scalar updates (only fields present in the body; null clears).
  const updates: Record<string, unknown> = {};
  if (testDate   !== undefined) updates['test_date']     = testDate;
  if (phNum      !== undefined) updates['ph']            = phNum;
  const ppmCols: Array<[string, unknown, string]> = [
    ['nitrogen', nitrogen, 'nitrogen_ppm'],
    ['phosphorus', phosphorus, 'phosphorus_ppm'],
    ['potassium', potassium, 'potassium_ppm'],
  ];
  for (const [field, value, col] of ppmCols) {
    if (value === undefined) continue;
    const r = numberField(value, { field, ...PPM_RANGE });
    if (!r.ok) {
      res.status(400).json({ error: r.error });
      return;
    }
    updates[col] = r.value;
  }
  if (notes !== undefined) {
    const r = textField(notes, { field: 'notes', max: NOTES_MAX });
    if (!r.ok) {
      res.status(400).json({ error: r.error });
      return;
    }
    updates['notes'] = r.value;
  }

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

    invalidateMetrics(accountId);
    res.json(formatReading(rows[0]));
  } catch (err) {
    logger.error('PATCH /soil-readings/:id failed', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── DELETE /api/soil-readings/:id ─────────────────────────────────────────────

soilFlatRouter.delete('/:id', writeLimiter, async (req: Request, res: Response): Promise<void> => {
  const accountId = req.session!.account!.id;
  const readingId = req.params.id as string;

  if (!isNumericId(readingId)) {
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
    invalidateMetrics(accountId);
    res.status(204).send();
  } catch (err) {
    logger.error('DELETE /soil-readings/:id failed', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

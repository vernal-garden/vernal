import { Router, Request, Response } from 'express';
import { db } from '../lib/db';
import { requireAuth, requireSupporter } from '../middleware/auth';

export const amendmentsNestedRouter = Router({ mergeParams: true }); // /api/gardens/:gardenId/amendments
export const amendmentsFlatRouter   = Router({ mergeParams: true }); // /api/amendments/:id

amendmentsNestedRouter.use(requireAuth, requireSupporter);
amendmentsFlatRouter.use(requireAuth, requireSupporter);

// ── Constants ─────────────────────────────────────────────────────────────────

const AMENDMENT_TYPES = [
  'fertilizer_synthetic', 'fertilizer_organic', 'compost_manure',
  'lime', 'sulphur', 'mulch', 'other',
] as const;
type AmendmentType = typeof AMENDMENT_TYPES[number];

const DIGITS_RE = /^\d+$/;
const DATE_RE   = /^\d{4}-\d{2}-\d{2}$/;

// ── Types ─────────────────────────────────────────────────────────────────────

interface AmendmentRow {
  id: string;
  garden_id: string;
  application_date: string;
  product_name: string;
  amendment_type: string;
  amount: string | null;
  amount_unit: string | null;
  application_method: string | null;
  notes: string | null;
  created_at: string;
  bed_ids: string[] | null;
}

// ── Formatter ─────────────────────────────────────────────────────────────────

function formatLog(row: AmendmentRow) {
  return {
    id:                row.id,
    gardenId:          row.garden_id,
    bedIds:            row.bed_ids ?? [],
    applicationDate:   row.application_date,
    productName:       row.product_name,
    amendmentType:     row.amendment_type,
    amount:            row.amount !== null ? Number(row.amount) : null,
    amountUnit:        row.amount_unit ?? null,
    applicationMethod: row.application_method ?? null,
    notes:             row.notes ?? null,
    createdAt:         row.created_at,
  };
}

// ── Helper: fetch one log with aggregated bedIds ───────────────────────────────

async function fetchLogById(id: string, accountId: number): Promise<AmendmentRow | null> {
  const { rows } = await db.query<AmendmentRow>(
    `SELECT al.id::text, al.garden_id::text, al.application_date::text,
            al.product_name, al.amendment_type, al.amount, al.amount_unit,
            al.application_method, al.notes, al.created_at,
            array_remove(array_agg(alb.bed_id::text ORDER BY alb.bed_id), NULL) AS bed_ids
       FROM amendment_logs al
       LEFT JOIN amendment_log_beds alb ON alb.amendment_log_id = al.id
      WHERE al.id = $1 AND al.user_id = $2
      GROUP BY al.id`,
    [id, accountId],
  );
  return rows[0] ?? null;
}

// ── GET /api/gardens/:gardenId/amendments ─────────────────────────────────────

amendmentsNestedRouter.get('/', async (req: Request, res: Response): Promise<void> => {
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

    const { rows } = await db.query<AmendmentRow>(
      `SELECT al.id::text, al.garden_id::text, al.application_date::text,
              al.product_name, al.amendment_type, al.amount, al.amount_unit,
              al.application_method, al.notes, al.created_at,
              array_remove(array_agg(alb.bed_id::text ORDER BY alb.bed_id), NULL) AS bed_ids
         FROM amendment_logs al
         LEFT JOIN amendment_log_beds alb ON alb.amendment_log_id = al.id
        WHERE al.garden_id = $1 AND al.user_id = $2
        GROUP BY al.id
        ORDER BY al.application_date DESC, al.created_at DESC`,
      [gardenId, accountId],
    );

    res.json({ data: rows.map(formatLog) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/gardens/:gardenId/amendments ────────────────────────────────────

amendmentsNestedRouter.post('/', async (req: Request, res: Response): Promise<void> => {
  const accountId = req.session!.account!.id;
  const gardenId  = req.params.gardenId as string;

  if (!DIGITS_RE.test(gardenId)) {
    res.status(404).json({ error: 'Garden not found' });
    return;
  }

  const {
    bedIds, applicationDate, productName, amendmentType,
    amount, amountUnit, applicationMethod, notes,
  } = req.body as Record<string, unknown>;

  // Validate required fields
  if (!Array.isArray(bedIds) || bedIds.length === 0) {
    res.status(400).json({ error: 'bedIds must be a non-empty array' });
    return;
  }
  if ((bedIds as unknown[]).some((id) => !DIGITS_RE.test(String(id)))) {
    res.status(400).json({ error: 'bedIds must contain positive integers' });
    return;
  }
  if (!applicationDate || !DATE_RE.test(String(applicationDate))) {
    res.status(400).json({ error: 'applicationDate is required (YYYY-MM-DD)' });
    return;
  }
  const productNameTrimmed = productName !== undefined ? String(productName).trim() : '';
  if (!productNameTrimmed) {
    res.status(400).json({ error: 'productName is required' });
    return;
  }
  if (!AMENDMENT_TYPES.includes(amendmentType as AmendmentType)) {
    res.status(400).json({ error: `amendmentType must be one of: ${AMENDMENT_TYPES.join(', ')}` });
    return;
  }

  const amountVal = amount !== undefined && amount !== null
    ? (isFinite(Number(amount)) ? Number(amount) : null)
    : null;
  const amountUnitVal        = amountUnit          !== undefined && amountUnit          !== null ? String(amountUnit)          : null;
  const applicationMethodVal = applicationMethod   !== undefined && applicationMethod   !== null ? String(applicationMethod)   : null;
  const notesVal             = notes              !== undefined && notes              !== null ? String(notes)              : null;

  const uniqueBedIds = [...new Set((bedIds as unknown[]).map(String))];

  try {
    const gRes = await db.query<{ id: string }>(
      'SELECT id FROM gardens WHERE id = $1 AND owner_id = $2',
      [gardenId, accountId],
    );
    if (gRes.rowCount === 0) {
      res.status(404).json({ error: 'Garden not found' });
      return;
    }

    // Validate all bedIds belong to this garden
    const bRes = await db.query<{ id: string }>(
      'SELECT id FROM beds WHERE id = ANY($1::int[]) AND garden_id = $2',
      [uniqueBedIds, gardenId],
    );
    if ((bRes.rowCount ?? 0) !== uniqueBedIds.length) {
      res.status(400).json({ error: 'One or more bedIds do not belong to this garden' });
      return;
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      const logRes = await client.query<{ id: string }>(
        `INSERT INTO amendment_logs
           (user_id, garden_id, application_date, product_name, amendment_type,
            amount, amount_unit, application_method, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id::text`,
        [accountId, gardenId, applicationDate, productNameTrimmed, amendmentType,
         amountVal, amountUnitVal, applicationMethodVal, notesVal],
      );
      const logId = logRes.rows[0].id;

      for (const bedId of uniqueBedIds) {
        await client.query(
          'INSERT INTO amendment_log_beds (amendment_log_id, bed_id) VALUES ($1, $2)',
          [logId, bedId],
        );
      }

      await client.query('COMMIT');

      const log = await fetchLogById(logId, accountId);
      res.status(201).json(log ? formatLog(log) : { id: logId });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── PATCH /api/amendments/:id ─────────────────────────────────────────────────

amendmentsFlatRouter.patch('/:id', async (req: Request, res: Response): Promise<void> => {
  const accountId   = req.session!.account!.id;
  const amendmentId = req.params.id as string;

  if (!DIGITS_RE.test(amendmentId)) {
    res.status(404).json({ error: 'Amendment not found' });
    return;
  }

  const {
    applicationDate, productName, amendmentType,
    amount, amountUnit, applicationMethod, notes, bedIds,
  } = req.body as Record<string, unknown>;

  // Validate provided fields
  if (applicationDate !== undefined && !DATE_RE.test(String(applicationDate))) {
    res.status(400).json({ error: 'applicationDate must be YYYY-MM-DD' });
    return;
  }
  if (productName !== undefined && !String(productName).trim()) {
    res.status(400).json({ error: 'productName cannot be empty' });
    return;
  }
  if (amendmentType !== undefined && !AMENDMENT_TYPES.includes(amendmentType as AmendmentType)) {
    res.status(400).json({ error: `amendmentType must be one of: ${AMENDMENT_TYPES.join(', ')}` });
    return;
  }
  if (bedIds !== undefined) {
    if (!Array.isArray(bedIds) || bedIds.length === 0) {
      res.status(400).json({ error: 'bedIds must be a non-empty array' });
      return;
    }
    if ((bedIds as unknown[]).some((id) => !DIGITS_RE.test(String(id)))) {
      res.status(400).json({ error: 'bedIds must contain positive integers' });
      return;
    }
  }

  // Build scalar updates (no updated_at — column does not exist)
  const updates: Record<string, unknown> = {};
  if (applicationDate  !== undefined) updates['application_date']  = applicationDate;
  if (productName      !== undefined) updates['product_name']      = String(productName).trim();
  if (amendmentType    !== undefined) updates['amendment_type']    = amendmentType;
  if (amount           !== undefined) updates['amount']            = amount !== null && isFinite(Number(amount)) ? Number(amount) : null;
  if (amountUnit       !== undefined) updates['amount_unit']       = amountUnit       !== null ? String(amountUnit)       : null;
  if (applicationMethod !== undefined) updates['application_method'] = applicationMethod !== null ? String(applicationMethod) : null;
  if (notes            !== undefined) updates['notes']             = notes            !== null ? String(notes)            : null;

  const hasBedIds = bedIds !== undefined;

  if (Object.keys(updates).length === 0 && !hasBedIds) {
    res.status(400).json({ error: 'No fields to update' });
    return;
  }

  try {
    // Verify ownership and resolve garden_id
    const aRes = await db.query<{ garden_id: string }>(
      'SELECT garden_id::text FROM amendment_logs WHERE id = $1 AND user_id = $2',
      [amendmentId, accountId],
    );
    if (aRes.rowCount === 0) {
      res.status(404).json({ error: 'Amendment not found' });
      return;
    }
    const gardenId = aRes.rows[0].garden_id;

    let uniqueBedIds: string[] = [];
    if (hasBedIds) {
      uniqueBedIds = [...new Set((bedIds as unknown[]).map(String))];
      const bRes = await db.query<{ id: string }>(
        'SELECT id FROM beds WHERE id = ANY($1::int[]) AND garden_id = $2',
        [uniqueBedIds, gardenId],
      );
      if ((bRes.rowCount ?? 0) !== uniqueBedIds.length) {
        res.status(400).json({ error: 'One or more bedIds do not belong to this garden' });
        return;
      }
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      if (Object.keys(updates).length > 0) {
        const cols = Object.keys(updates);
        const sets = cols.map((col, i) => `${col} = $${i + 1}`);
        const vals: unknown[] = [...cols.map(c => updates[c]), amendmentId, accountId];
        const n = cols.length;

        await client.query(
          `UPDATE amendment_logs SET ${sets.join(', ')}
            WHERE id = $${n + 1} AND user_id = $${n + 2}`,
          vals,
        );
      }

      if (hasBedIds) {
        await client.query(
          'DELETE FROM amendment_log_beds WHERE amendment_log_id = $1',
          [amendmentId],
        );
        for (const bedId of uniqueBedIds) {
          await client.query(
            'INSERT INTO amendment_log_beds (amendment_log_id, bed_id) VALUES ($1, $2)',
            [amendmentId, bedId],
          );
        }
      }

      await client.query('COMMIT');

      const log = await fetchLogById(amendmentId, accountId);
      res.json(log ? formatLog(log) : {});
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── DELETE /api/amendments/:id ────────────────────────────────────────────────

amendmentsFlatRouter.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  const accountId   = req.session!.account!.id;
  const amendmentId = req.params.id as string;

  if (!DIGITS_RE.test(amendmentId)) {
    res.status(404).json({ error: 'Amendment not found' });
    return;
  }

  try {
    const { rowCount } = await db.query(
      'DELETE FROM amendment_logs WHERE id = $1 AND user_id = $2 RETURNING id',
      [amendmentId, accountId],
    );
    if (rowCount === 0) {
      res.status(404).json({ error: 'Amendment not found' });
      return;
    }
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

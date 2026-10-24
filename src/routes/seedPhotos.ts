import express, { Router } from 'express';
import crypto from 'crypto';
import { db } from '../lib/db';
import { logger } from '../lib/logger';
import { requireSupporter } from '../middleware/auth';
import { writeLimiter } from '../middleware/rateLimiters';
import { isNumericId } from '../lib/validation';
import { isR2ConfigError, uploadToR2 } from '../lib/r2';
import { queueR2Deletions, drainSoon } from '../lib/r2Cleanup';
import { ImageBusyError, ImageRejectedError, processPhoto } from '../lib/imageProcessing';

// Mounted by seeds.ts at /api/seeds/:id/photos, after its router.use(requireAuth).
const router = Router({ mergeParams: true });

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_PHOTOS_PER_SEED = 3;
const MAX_NOTES_LENGTH = 500;
const STORAGE_UNAVAILABLE = 'Photo storage is not configured.';
const NOT_AN_IMAGE = "That file isn't a supported image.";

// The photo is the raw request body; any other Content-Type leaves req.body
// unset (or parsed as JSON), which the route answers with NOT_AN_IMAGE.
const photoBody = express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '5mb' });

// ── Types ─────────────────────────────────────────────────────────────────────

interface PhotoRow {
  id: string;
  storage_url: string;
  r2_key: string;
  notes: string | null;
  created_at: string;
}

const PHOTO_SELECT = 'id::text, storage_url, r2_key, notes, created_at';

// The url is built from the key at read time so a change of public base URL
// never strands old rows; storage_url is only the fallback when it's unset.
function formatPhoto(row: PhotoRow) {
  const base = publicBaseUrl();
  return {
    id: row.id,
    url: base ? `${base}/${row.r2_key}` : row.storage_url,
    notes: row.notes,
    createdAt: row.created_at,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Returns the cleaned notes value, or an error message for a 400.
function parseNotes(v: unknown): { notes: string | null } | { error: string } {
  if (v === undefined || v === null) return { notes: null };
  if (typeof v !== 'string') return { error: 'Notes must be text.' };
  const trimmed = v.trim();
  if (trimmed.length > MAX_NOTES_LENGTH) {
    return { error: `Notes must be ${MAX_NOTES_LENGTH} characters or fewer.` };
  }
  return { notes: trimmed || null };
}

function publicBaseUrl(): string | null {
  const u = process.env.R2_PUBLIC_BASE_URL;
  return u ? u.replace(/\/$/, '') : null;
}

async function ownsSeed(seedId: string, accountId: number): Promise<boolean> {
  const { rows } = await db.query(
    'SELECT 1 FROM seeds WHERE id = $1 AND owner_id = $2',
    [seedId, accountId],
  );
  return rows.length > 0;
}

async function photoCount(seedId: string): Promise<number> {
  const { rows } = await db.query<{ count: number }>(
    'SELECT COUNT(*)::int AS count FROM seed_photos WHERE seed_id = $1',
    [seedId],
  );
  return rows[0].count;
}

// Called after the upload landed but the row didn't commit (the ROLLBACK
// would have undone a queue row written in the transaction), so the queue
// row goes in on its own through the pool. A failure here leaves an orphan
// for the sweep script; it is logged, not rethrown.
async function discardUpload(key: string): Promise<void> {
  try {
    const ids = await queueR2Deletions(db, [{ bucket: 'public', path: key, isPrefix: false }]);
    drainSoon(ids);
  } catch (err) {
    logger.error('Could not queue an unsaved seed photo for deletion', err, { key });
  }
}

// ── GET /api/seeds/:id/photos ─────────────────────────────────────────────────

router.get('/', async (req, res) => {
  const accountId = req.session!.account!.id;
  const seedId = (req.params as { id: string }).id;

  if (!isNumericId(seedId)) return res.status(400).json({ error: 'Invalid id' });

  try {
    if (!(await ownsSeed(seedId, accountId))) {
      return res.status(404).json({ error: 'Seed not found' });
    }

    const { rows } = await db.query<PhotoRow>(
      `SELECT ${PHOTO_SELECT} FROM seed_photos
       WHERE seed_id = $1
       ORDER BY created_at DESC, id DESC`,
      [seedId],
    );
    res.json({ photos: rows.map(formatPhoto) });
  } catch (err) {
    logger.error('GET /seeds/:id/photos failed', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/seeds/:id/photos ────────────────────────────────────────────────

// Body: the raw image. Optional X-Photo-Notes header, URI-encoded (headers
// can't carry raw non-ASCII).
router.post('/', requireSupporter, writeLimiter, photoBody, async (req, res) => {
  const accountId = req.session!.account!.id;
  const seedId = (req.params as { id: string }).id;

  if (!isNumericId(seedId)) return res.status(400).json({ error: 'Invalid id' });

  let rawNotes: string | undefined;
  try {
    const header = req.get('X-Photo-Notes');
    rawNotes = header === undefined ? undefined : decodeURIComponent(header);
  } catch {
    return res.status(400).json({ error: 'Notes must be text.' });
  }
  const notesResult = parseNotes(rawNotes);
  if ('error' in notesResult) {
    return res.status(400).json({ error: notesResult.error });
  }

  const input: unknown = req.body;
  if (!Buffer.isBuffer(input)) return res.status(400).json({ error: NOT_AN_IMAGE });

  // Set once the file is in R2; cleared just before COMMIT. Any exit in between queues
  // the key for deletion.
  let uploadedKey: string | null = null;

  try {
    // Cheap checks before the encode; repeated under the row lock below.
    if (!(await ownsSeed(seedId, accountId))) {
      return res.status(404).json({ error: 'Seed not found' });
    }
    if ((await photoCount(seedId)) >= MAX_PHOTOS_PER_SEED) {
      return res.status(409).json({ error: `Up to ${MAX_PHOTOS_PER_SEED} photos per seed.` });
    }
    const base = publicBaseUrl();
    if (!base) return res.status(503).json({ error: STORAGE_UNAVAILABLE });

    let photo: Buffer;
    try {
      photo = await processPhoto(input);
    } catch (err) {
      if (err instanceof ImageRejectedError) return res.status(400).json({ error: NOT_AN_IMAGE });
      if (err instanceof ImageBusyError) return res.status(503).json({ error: 'Busy, try again.' });
      throw err;
    }

    const key = `seed-photos/${seedId}/${crypto.randomUUID()}.jpg`;
    try {
      await uploadToR2(key, photo, 'image/jpeg');
    } catch (err) {
      if (isR2ConfigError(err)) return res.status(503).json({ error: STORAGE_UNAVAILABLE });
      throw err;
    }
    uploadedKey = key;

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      // Lock the seed row so concurrent uploads can't both pass the count check.
      const seedResult = await client.query(
        'SELECT 1 FROM seeds WHERE id = $1 AND owner_id = $2 FOR UPDATE',
        [seedId, accountId],
      );
      if (seedResult.rows.length === 0) {
        await client.query('ROLLBACK');
        await discardUpload(key);
        return res.status(404).json({ error: 'Seed not found' });
      }

      const countResult = await client.query<{ count: number }>(
        'SELECT COUNT(*)::int AS count FROM seed_photos WHERE seed_id = $1',
        [seedId],
      );
      if (countResult.rows[0].count >= MAX_PHOTOS_PER_SEED) {
        await client.query('ROLLBACK');
        await discardUpload(key);
        return res.status(409).json({ error: `Up to ${MAX_PHOTOS_PER_SEED} photos per seed.` });
      }

      const insert = await client.query<PhotoRow>(
        `INSERT INTO seed_photos (seed_id, storage_url, r2_key, notes)
         VALUES ($1, $2, $3, $4)
         RETURNING ${PHOTO_SELECT}`,
        [seedId, `${base}/${key}`, key, notesResult.notes],
      );

      // Cleared before COMMIT: if COMMIT errors the row may still have been
      // saved, and a stray object is safer than deleting a referenced photo.
      uploadedKey = null;
      await client.query('COMMIT');
      res.status(201).json(formatPhoto(insert.rows[0]));
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    if (uploadedKey) await discardUpload(uploadedKey);
    logger.error('POST /seeds/:id/photos failed', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── PATCH /api/seeds/:id/photos/:photoId ──────────────────────────────────────

router.patch('/:photoId', writeLimiter, async (req, res) => {
  const accountId = req.session!.account!.id;
  const seedId = (req.params as { id: string }).id;
  const photoId = req.params.photoId as string;

  if (!isNumericId(seedId) || !isNumericId(photoId)) {
    return res.status(400).json({ error: 'Invalid id' });
  }

  try {
    if (!(await ownsSeed(seedId, accountId))) {
      return res.status(404).json({ error: 'Seed not found' });
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.notes === undefined) {
      return res.status(400).json({ error: 'notes is required' });
    }
    const notesResult = parseNotes(body.notes);
    if ('error' in notesResult) {
      return res.status(400).json({ error: notesResult.error });
    }

    const { rows } = await db.query<PhotoRow>(
      `UPDATE seed_photos SET notes = $1
       WHERE id = $2 AND seed_id = $3
       RETURNING ${PHOTO_SELECT}`,
      [notesResult.notes, photoId, seedId],
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Photo not found' });
    }
    res.json(formatPhoto(rows[0]));
  } catch (err) {
    logger.error('PATCH /seeds/:id/photos/:photoId failed', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── DELETE /api/seeds/:id/photos/:photoId ─────────────────────────────────────

router.delete('/:photoId', writeLimiter, async (req, res) => {
  const accountId = req.session!.account!.id;
  const seedId = (req.params as { id: string }).id;
  const photoId = req.params.photoId as string;

  if (!isNumericId(seedId) || !isNumericId(photoId)) {
    return res.status(400).json({ error: 'Invalid id' });
  }

  try {
    if (!(await ownsSeed(seedId, accountId))) {
      return res.status(404).json({ error: 'Seed not found' });
    }

    const client = await db.connect();
    let queuedIds: number[] = [];
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ r2_key: string }>(
        'DELETE FROM seed_photos WHERE id = $1 AND seed_id = $2 RETURNING r2_key',
        [photoId, seedId],
      );
      if (rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Photo not found' });
      }
      queuedIds = await queueR2Deletions(client, [{ bucket: 'public', path: rows[0].r2_key, isPrefix: false }]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    drainSoon(queuedIds);
    res.status(204).send();
  } catch (err) {
    logger.error('DELETE /seeds/:id/photos/:photoId failed', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;

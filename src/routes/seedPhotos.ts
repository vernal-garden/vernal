import { Router } from 'express';
import crypto from 'crypto';
import { db } from '../lib/db';
import { requireSupporter } from '../middleware/auth';
import { writeLimiter } from '../middleware/rateLimiters';
import { isNumericId } from '../lib/validation';
import { getPresignedUploadUrl, isR2ConfigError } from '../lib/r2';
import { queueR2Deletions, drainSoon } from '../lib/r2Cleanup';

// Mounted by seeds.ts at /api/seeds/:id/photos, after its router.use(requireAuth).
const router = Router({ mergeParams: true });

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_PHOTOS_PER_SEED = 3;
const MAX_NOTES_LENGTH = 500;
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const STORAGE_UNAVAILABLE = 'Photo storage is not configured.';

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
    console.error('GET /seeds/:id/photos error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/seeds/:id/photos/upload-url ─────────────────────────────────────

router.post('/upload-url', requireSupporter, writeLimiter, async (req, res) => {
  const accountId = req.session!.account!.id;
  const seedId = (req.params as { id: string }).id;

  if (!isNumericId(seedId)) return res.status(400).json({ error: 'Invalid id' });

  try {
    if (!(await ownsSeed(seedId, accountId))) {
      return res.status(404).json({ error: 'Seed not found' });
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.contentType !== 'image/jpeg') {
      return res.status(400).json({ error: 'Photos must be JPEG.' });
    }
    const size = body.size;
    if (typeof size !== 'number' || !Number.isInteger(size) || size < 1 || size > MAX_PHOTO_BYTES) {
      return res.status(400).json({ error: 'Photos must be 5 MB or smaller.' });
    }

    if ((await photoCount(seedId)) >= MAX_PHOTOS_PER_SEED) {
      return res.status(409).json({ error: `Up to ${MAX_PHOTOS_PER_SEED} photos per seed.` });
    }

    const key = `seed-photos/${seedId}/${crypto.randomUUID()}.jpg`;
    let uploadUrl: string;
    try {
      uploadUrl = await getPresignedUploadUrl(key, 'image/jpeg', size, 300);
    } catch (err) {
      if (isR2ConfigError(err)) return res.status(503).json({ error: STORAGE_UNAVAILABLE });
      throw err;
    }

    res.json({ uploadUrl, key });
  } catch (err) {
    console.error('POST /seeds/:id/photos/upload-url error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/seeds/:id/photos ────────────────────────────────────────────────

router.post('/', requireSupporter, writeLimiter, async (req, res) => {
  const accountId = req.session!.account!.id;
  const seedId = (req.params as { id: string }).id;

  if (!isNumericId(seedId)) return res.status(400).json({ error: 'Invalid id' });

  const body = (req.body ?? {}) as Record<string, unknown>;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Lock the seed row so concurrent confirms can't both pass the count check.
    const seedResult = await client.query(
      'SELECT 1 FROM seeds WHERE id = $1 AND owner_id = $2 FOR UPDATE',
      [seedId, accountId],
    );
    if (seedResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Seed not found' });
    }

    const keyRe = new RegExp(`^seed-photos/${seedId}/[0-9a-f-]{36}\\.jpg$`);
    if (typeof body.key !== 'string' || !keyRe.test(body.key)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Invalid photo key.' });
    }
    const key = body.key;

    const notesResult = parseNotes(body.notes);
    if ('error' in notesResult) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: notesResult.error });
    }

    const base = publicBaseUrl();
    if (!base) {
      await client.query('ROLLBACK');
      return res.status(503).json({ error: STORAGE_UNAVAILABLE });
    }

    const countResult = await client.query<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM seed_photos WHERE seed_id = $1',
      [seedId],
    );
    if (countResult.rows[0].count >= MAX_PHOTOS_PER_SEED) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Up to ${MAX_PHOTOS_PER_SEED} photos per seed.` });
    }

    let row: PhotoRow;
    try {
      const insert = await client.query<PhotoRow>(
        `INSERT INTO seed_photos (seed_id, storage_url, r2_key, notes)
         VALUES ($1, $2, $3, $4)
         RETURNING ${PHOTO_SELECT}`,
        [seedId, `${base}/${key}`, key, notesResult.notes],
      );
      row = insert.rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      if ((err as { code?: string }).code === '23505') {
        return res.status(409).json({ error: 'Photo already added.' });
      }
      throw err;
    }

    await client.query('COMMIT');
    res.status(201).json(formatPhoto(row));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /seeds/:id/photos error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
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
    console.error('PATCH /seeds/:id/photos/:photoId error:', err);
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
    console.error('DELETE /seeds/:id/photos/:photoId error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;

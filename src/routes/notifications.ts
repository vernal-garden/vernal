import { Router } from 'express';
import { db } from '../lib/db';
import { logger } from '../lib/logger';
import { requireAuth } from '../middleware/auth';
import { writeLimiter } from '../middleware/rateLimiters';
import { isNumericId } from '../lib/validation';

const router = Router();
router.use(requireAuth);

const PG_INT_MAX = 2_147_483_647;

// GET /api/notifications — unread first, then newest
router.get('/', async (req, res) => {
  const accountId = req.session!.account!.id;
  try {
    const [list, count] = await Promise.all([
      db.query(
        `SELECT id, type, payload, read_at, created_at
         FROM notifications
         WHERE account_id = $1
         ORDER BY (read_at IS NULL) DESC, created_at DESC, id DESC
         LIMIT 30`,
        [accountId],
      ),
      db.query<{ n: number }>(
        'SELECT COUNT(*)::int AS n FROM notifications WHERE account_id = $1 AND read_at IS NULL',
        [accountId],
      ),
    ]);
    res.json({
      unreadCount: count.rows[0].n,
      data: list.rows.map((r) => ({
        id: r.id,
        type: r.type,
        payload: r.payload,
        readAt: r.read_at,
        createdAt: r.created_at,
      })),
    });
  } catch (err) {
    logger.error('GET /notifications failed', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/notifications/read-all
router.post('/read-all', writeLimiter, async (req, res) => {
  const accountId = req.session!.account!.id;
  try {
    const result = await db.query(
      'UPDATE notifications SET read_at = now() WHERE account_id = $1 AND read_at IS NULL',
      [accountId],
    );
    res.json({ updated: result.rowCount ?? 0 });
  } catch (err) {
    logger.error('POST /notifications/read-all failed', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/notifications/:id/read
router.patch('/:id/read', writeLimiter, async (req, res) => {
  const accountId = req.session!.account!.id;
  const rawId = req.params.id as string;
  if (!isNumericId(rawId) || Number(rawId) > PG_INT_MAX) {
    return res.status(400).json({ error: 'id must be a numeric id' });
  }

  try {
    const result = await db.query<{ id: number; read_at: Date }>(
      `UPDATE notifications SET read_at = COALESCE(read_at, now())
       WHERE id = $1 AND account_id = $2
       RETURNING id, read_at`,
      [rawId, accountId],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Not found' });
    }
    res.json({ id: result.rows[0].id, readAt: result.rows[0].read_at });
  } catch (err) {
    logger.error('PATCH /notifications/:id/read failed', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;

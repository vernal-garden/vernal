import { Router } from 'express';
import { db } from '../lib/db';
import { requireAuth } from '../middleware/auth';
import { isNumericId } from '../lib/validation';
import { LIMITS } from '../lib/limits';
import { writeLimiter } from '../middleware/rateLimiters';

const router = Router();
router.use(requireAuth);

// POST /api/corrections
router.post('/', writeLimiter, async (req, res) => {
  const accountId = req.session!.account!.id;
  const body = req.body as Record<string, unknown>;

  if (body.seedId !== undefined) {
    return res
      .status(400)
      .json({ error: 'personal seeds are edited directly — use PATCH /api/seeds/:id' });
  }

  const { cambiumSeedId: rawCambiumSeedId, correctionText: rawText } = body;

  if (rawCambiumSeedId === undefined || rawCambiumSeedId === null) {
    return res.status(400).json({ error: 'cambiumSeedId is required' });
  }
  const cambiumSeedIdStr = String(rawCambiumSeedId);
  if (!isNumericId(cambiumSeedIdStr)) {
    return res.status(400).json({ error: 'cambiumSeedId must be a numeric id' });
  }

  if (typeof rawText !== 'string' || rawText.trim().length === 0) {
    return res.status(400).json({ error: 'correctionText is required' });
  }
  if (rawText.trim().length > 2000) {
    return res.status(400).json({ error: 'correctionText must be 2000 characters or fewer' });
  }
  const correctionText = rawText.trim();

  try {
    const seedResult = await db.query<{ id: number; common_name: string }>(
      `SELECT id, common_name FROM cambium.seeds WHERE id = $1 AND moderation_status = 'active'`,
      [cambiumSeedIdStr],
    );
    if (seedResult.rows.length === 0) {
      return res.status(400).json({ error: 'Cambium seed not found or not active' });
    }

    const { common_name } = seedResult.rows[0];

    // Lock the account row so parallel submissions count and insert one at a
    // time; otherwise several could all pass the daily check before any inserts.
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query('SELECT 1 FROM accounts WHERE id = $1 FOR NO KEY UPDATE', [accountId]);
      if (locked.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(401).json({ error: 'Account not found' });
      }
      const { rows: recent } = await client.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM moderation_items
         WHERE type = 'correction' AND submitted_by = $1 AND created_at > now() - interval '24 hours'`,
        [accountId],
      );
      if (recent[0].n >= LIMITS.correctionsPerDay) {
        await client.query('ROLLBACK');
        return res.status(429).json({
          error: `You've sent ${LIMITS.correctionsPerDay} corrections today. Please try again tomorrow.`,
        });
      }

      await client.query(
        `INSERT INTO moderation_items (type, cambium_seed_id, submitted_by, content)
         VALUES ('correction', $1, $2, $3)`,
        [cambiumSeedIdStr, accountId, JSON.stringify({ correctionText, seedName: common_name })],
      );
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK').catch(() => undefined);
      const pgErr = txErr as { code?: string; constraint?: string };
      if (pgErr.code === '23505' && pgErr.constraint === 'moderation_items_open_correction_uniq') {
        return res.status(409).json({ error: 'You already have a pending correction for this seed.' });
      }
      throw txErr;
    } finally {
      client.release();
    }

    res.status(201).json({ received: true });
  } catch (err) {
    console.error('POST /corrections error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;

import { Router } from 'express';
import { db } from '../lib/db';
import { requireAuth } from '../middleware/auth';

const router = Router();
router.use(requireAuth);

// POST /api/corrections
router.post('/', async (req, res) => {
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
  if (!/^\d+$/.test(cambiumSeedIdStr)) {
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

    await db.query(
      `INSERT INTO moderation_items (type, cambium_seed_id, submitted_by, content)
       VALUES ('correction', $1, $2, $3)`,
      [cambiumSeedIdStr, accountId, JSON.stringify({ correctionText, seedName: common_name })],
    );

    res.status(201).json({ received: true });
  } catch (err) {
    console.error('POST /corrections error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;

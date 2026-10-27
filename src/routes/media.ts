import { Router, type Response } from 'express';
import { db } from '../lib/db';
import { logger } from '../lib/logger';
import { getMediaRedirectUrl, isR2ConfigError } from '../lib/r2';
import { parseMediaKey, thumbnailKey } from '../lib/media';

// GET /api/media/<key> — a photo or garden thumbnail, for its owner only.
// Redirects to a signed R2 link. Every refusal is the same 404 so the route
// never reveals whether a key exists.
const router = Router();

const HOUR_MS = 60 * 60 * 1000;

function notFound(res: Response) {
  return res.status(404).json({ error: 'Not found' });
}

async function owns(key: string, accountId: number | null, sessionId: string): Promise<boolean> {
  const parsed = parseMediaKey(key);
  if (!parsed) return false;
  if (parsed.kind === 'seed') {
    // Seed photos are an account feature; guests never own one.
    if (accountId === null) return false;
    const { rows } = await db.query(
      `SELECT 1 FROM seed_photos sp JOIN seeds s ON s.id = sp.seed_id
        WHERE sp.r2_key = $1 AND s.owner_id = $2`,
      [key, accountId],
    );
    return rows.length > 0;
  }
  if (parsed.kind === 'harvest') {
    const { rows } = await db.query(
      `SELECT 1 FROM harvest_entries h JOIN gardens g ON g.id = h.garden_id
        WHERE h.id = $1 AND (g.owner_id = $2 OR g.guest_session_id = $3)
          AND h.photos @> jsonb_build_array(jsonb_build_object('key', $4::text))`,
      [parsed.id, accountId, sessionId, key],
    );
    return rows.length > 0;
  }
  // A thumbnail is owned only while it is the garden's current one.
  const { rows } = await db.query<{ thumbnail_url: string | null }>(
    `SELECT thumbnail_url FROM gardens
      WHERE id = $1 AND (owner_id = $2 OR guest_session_id = $3)`,
    [parsed.id, accountId, sessionId],
  );
  return rows.length > 0 && thumbnailKey(rows[0].thumbnail_url, parsed.id) === key;
}

router.get('/*key', async (req, res) => {
  const session = req.session;
  if (!session) return notFound(res);
  // req.path is still percent-encoded; a valid key has nothing to decode, so
  // anything encoded fails parseMediaKey and gets the 404.
  const key = req.path.slice(1);
  try {
    if (!(await owns(key, session.account?.id ?? null, session.id))) return notFound(res);
    const now = new Date();
    const location = await getMediaRedirectUrl(key, now);
    // The signed URL changes on the hour, so the redirect is cached until then.
    const untilNextHour = Math.ceil((HOUR_MS - (now.getTime() % HOUR_MS)) / 1000);
    res.set('Cache-Control', `private, max-age=${Math.max(60, untilNextHour)}`);
    return res.redirect(302, location);
  } catch (err) {
    if (isR2ConfigError(err)) {
      return res.status(503).json({ error: 'Photo storage is not configured.' });
    }
    logger.error('GET /api/media failed', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;

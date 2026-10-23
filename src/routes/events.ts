import { Router, Request, Response } from 'express';
import { db } from '../lib/db';
import { logger } from '../lib/logger';
import { requireSession } from '../middleware/auth';
import { writeLimiter, eventsBatchLimiter } from '../middleware/rateLimiters';
import { isEventKey } from '../lib/eventKeys';

const eventsRouter = Router();

const MAX_BATCH = 50;
const MAX_PAST_MS = 24 * 60 * 60 * 1000;
const MAX_FUTURE_MS = 5 * 60 * 1000;

// Client timestamps are accepted only within [now - 24h, now + 5m]; anything
// missing, unparseable, or outside that window falls back to the server's now.
function resolveCreatedAt(timestamp: unknown, now: Date): Date {
  if (typeof timestamp !== 'string') return now;
  const ms = Date.parse(timestamp);
  if (Number.isNaN(ms)) return now;
  if (ms < now.getTime() - MAX_PAST_MS || ms > now.getTime() + MAX_FUTURE_MS) return now;
  return new Date(ms);
}

// ── POST /batch ───────────────────────────────────────────────────────────────

eventsRouter.post('/batch', requireSession, writeLimiter, eventsBatchLimiter, async (req: Request, res: Response): Promise<void> => {
  const { events } = (req.body ?? {}) as { events?: unknown };

  if (!Array.isArray(events)) {
    res.status(400).json({ error: 'events must be an array' });
    return;
  }
  if (events.length > MAX_BATCH) {
    res.status(400).json({ error: 'Too many events' });
    return;
  }

  // Identity comes from the session only — never from the body.
  const sessionId = req.session!.id;
  const userId = req.session!.account?.id ?? null;
  const now = new Date();

  const values: unknown[] = [];
  const tuples: string[] = [];
  for (const entry of events) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { event_key: key, timestamp } = entry as { event_key?: unknown; timestamp?: unknown };
    if (typeof key !== 'string' || !isEventKey(key)) continue;
    const base = values.length;
    values.push(userId, sessionId, key, resolveCreatedAt(timestamp, now));
    tuples.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
  }

  try {
    if (tuples.length > 0) {
      await db.query(
        `INSERT INTO usage_events (user_id, session_id, event_key, created_at) VALUES ${tuples.join(', ')}`,
        values,
      );
    }
    res.status(204).send();
  } catch (err) {
    logger.error('POST /events/batch failed', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default eventsRouter;

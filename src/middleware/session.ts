import { Request, Response, NextFunction } from 'express';
import { findSession, COOKIE_NAME } from '../lib/sessions';
import { db } from '../lib/db';
import { logger } from '../lib/logger';

const ACTIVITY_BUMP_INTERVAL_MS = 60 * 60 * 1000;

// accountId → time (ms) of the last last_active_at bump issued by this process.
// Keeps the UPDATE to at most once per account per hour per process; the SQL
// guard below covers multiple processes.
const lastActivityBump = new Map<number, number>();

function bumpLastActive(accountId: number): void {
  const now = Date.now();
  const last = lastActivityBump.get(accountId);
  if (last !== undefined && now - last < ACTIVITY_BUMP_INTERVAL_MS) return;
  lastActivityBump.set(accountId, now);

  db.query(
    `UPDATE accounts SET last_active_at = now()
      WHERE id = $1
        AND (last_active_at IS NULL OR last_active_at < now() - interval '1 hour')`,
    [accountId],
  ).catch((err: unknown) => {
    logger.warn('last_active_at update failed', {
      accountId,
      errMsg: err instanceof Error ? err.message : String(err),
    });
  });
}

// Attaches session data to req.session on every request.
// Sets req.session = null if no valid cookie is present.
// Responds 503 if the session lookup itself fails (DB down or saturated).
// Does NOT block unauthenticated requests. That is the job of requireAuth (Phase 06).
export async function sessionMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const signed = req.cookies?.[COOKIE_NAME];

  // cookie-parser can yield non-strings (e.g. "j:1" parses to the number 1).
  if (typeof signed !== 'string' || !signed) {
    req.session = null;
    return next();
  }

  try {
    req.session = await findSession(signed);
  } catch (err) {
    // Fail closed: treating a DB error as "no session" would log everyone out
    // and let the client mint a fresh guest session on top of their real one.
    logger.warn('Session lookup failed', { errMsg: err instanceof Error ? err.message : String(err) });
    res.set('Retry-After', '5');
    res.status(503).json({ error: 'Server is busy — please try again shortly' });
    return;
  }

  if (req.session?.account) {
    bumpLastActive(req.session.account.id);
  }

  next();
}

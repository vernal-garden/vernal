import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { db } from '../lib/db';

// Requests queued for a pool connection beyond this are shed with 503 rather
// than piling up until connectionTimeoutMillis and failing slowly.
export const DB_WAITING_LIMIT = 50;

export function makeDbBackpressure(getWaiting: () => number, limit: number): RequestHandler {
  return (_req: Request, res: Response, next: NextFunction) => {
    if (getWaiting() > limit) {
      res.set('Retry-After', '5');
      res.status(503).json({ error: 'Server is busy — please try again shortly' });
      return;
    }
    next();
  };
}

export const dbBackpressure = makeDbBackpressure(() => db.waitingCount, DB_WAITING_LIMIT);

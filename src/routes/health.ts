import { Router, Request, Response } from 'express';
import { db } from '../lib/db';

export const healthRouter = Router();

healthRouter.get('/', async (_req: Request, res: Response): Promise<void> => {
  let dbStatus: 'ok' | 'error' = 'error';
  try {
    await db.query('SELECT 1');
    dbStatus = 'ok';
  } catch {
    // db not reachable — still respond so the health check doesn't timeout
  }

  const healthy = dbStatus === 'ok';
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    db: dbStatus,
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version ?? 'unknown',
  });
});

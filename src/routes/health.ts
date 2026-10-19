import { readFileSync } from 'fs';
import path from 'path';
import { Router, Request, Response } from 'express';
import { db } from '../lib/db';

export const healthRouter = Router();

// Read once at startup. npm_package_version is only set under `npm start`, and
// pm2 runs dist/index.js directly. Both src/routes and dist/routes sit two
// levels below the repo root, so the same relative path works in dev and prod.
// (A JSON import would fall outside tsconfig's rootDir.)
function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(__dirname, '../../package.json'), 'utf-8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

const VERSION = readVersion();

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
    version: VERSION,
  });
});

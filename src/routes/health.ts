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

// The DB status is cached for a few seconds and computed by one check at a
// time, so a flood of /health hits costs at most one SELECT 1 per window. The
// check never queues on a busy pool (reported live, never cached), gives up
// after 2 s, and never has more than one SELECT 1 outstanding, even after a
// timeout.
const CACHE_MS = 5_000;
const CHECK_TIMEOUT_MS = 2_000;

type DbStatus = 'ok' | 'error';
let cached: { status: DbStatus; at: number } | null = null;
let inFlight: Promise<DbStatus> | null = null;
let queryPending = false;

export async function checkDb(): Promise<DbStatus> {
  if (queryPending) return 'error';
  queryPending = true;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<DbStatus>((resolve) => {
    timer = setTimeout(() => resolve('error'), CHECK_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      db.query('SELECT 1').then(
        (): DbStatus => 'ok',
        (): DbStatus => 'error',
      ).finally(() => {
        queryPending = false;
      }),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function dbStatus(): Promise<DbStatus> {
  if (cached && Date.now() - cached.at < CACHE_MS) return Promise.resolve(cached.status);
  if (db.waitingCount > 0) return Promise.resolve('error');
  if (!inFlight) {
    const p: Promise<DbStatus> = checkDb()
      .then((status) => {
        cached = { status, at: Date.now() };
        return status;
      })
      .finally(() => {
        if (inFlight === p) inFlight = null;
      });
    inFlight = p;
  }
  return inFlight;
}

export function resetHealthCacheForTests(): void {
  cached = null;
  inFlight = null;
  queryPending = false;
}

healthRouter.get('/', async (_req: Request, res: Response): Promise<void> => {
  const status = await dbStatus();
  const healthy = status === 'ok';
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    db: status,
    timestamp: new Date().toISOString(),
    version: VERSION,
  });
});

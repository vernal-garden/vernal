import { Pool, PoolConfig } from 'pg';
import dotenv from 'dotenv';
import * as Sentry from '@sentry/node';
import { logger } from './logger';

dotenv.config();

// During tests (NODE_ENV=test, set automatically by Vitest) the app must
// connect to TEST_DATABASE_URL, never DATABASE_URL — otherwise supertest
// requests through `app` would read/write the real production database.
const connectionString =
  process.env.NODE_ENV === 'test' ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    process.env.NODE_ENV === 'test'
      ? 'TEST_DATABASE_URL environment variable is required'
      : 'DATABASE_URL environment variable is required',
  );
}

// Neon silently drops pg's `statement_timeout` startup setting, and its pooled
// endpoint rejects it in `options` ("unsupported startup parameter"), so the
// cap only works through `options` on a direct (non -pooler) host.
export function statementTimeoutOptions(connectionString: string, ms: number): string | undefined {
  let host = '';
  try {
    host = new URL(connectionString).hostname;
  } catch {
    // Leave a malformed string for pg to report.
  }
  return host.includes('-pooler') ? undefined : `-c statement_timeout=${ms}`;
}

const webTimeoutOptions = statementTimeoutOptions(connectionString, 10_000);
if (webTimeoutOptions === undefined) {
  console.warn(
    "[db] DATABASE_URL uses Neon's pooled endpoint; statement_timeout is not applied. Use the direct (non -pooler) host.",
  );
}

const config: PoolConfig = {
  connectionString,
  // SSL is required for Neon; test mode targets a local/throwaway Postgres
  // (no SSL). DATABASE_SSL=false also disables it for local dev without SSL.
  ssl:
    process.env.NODE_ENV === 'test' || process.env.DATABASE_SSL === 'false'
      ? false
      : { rejectUnauthorized: false },
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  // Server-side cap on any one statement (see statementTimeoutOptions).
  options: webTimeoutOptions,
  // Client-side cap: rejects the query promise if the server hasn't answered.
  query_timeout: 15_000,
};

export const db = new Pool(config);

// An idle client can error (e.g. the server drops the connection). With no
// listener, pg re-emits it as an uncaught exception and the process dies.
db.on('error', (err) => {
  logger.error('[db] Idle client error', err);
});

// Background work (nightly job, data exports) gets its own small pool with a
// much longer statement cap, so the 10s web limit can't cancel a legitimately
// long purge — scheduled account deletions must actually finish. No
// query_timeout here for the same reason.
export const jobDb = new Pool({
  ...config,
  max: 3,
  // Exports and the nightly job can overlap on 3 connections; wait for one.
  connectionTimeoutMillis: 30_000,
  options: statementTimeoutOptions(connectionString, 5 * 60_000),
  query_timeout: undefined,
});

jobDb.on('error', (err) => {
  logger.error('[db] Idle job client error', err);
});

// Logs the cap each pool actually got, so a host or provider change that
// silently drops it shows up in the pm2 log.
async function reportStatementTimeouts(): Promise<void> {
  try {
    const [web, jobs] = await Promise.all([
      db.query('SHOW statement_timeout'),
      jobDb.query('SHOW statement_timeout'),
    ]);
    console.info(
      `[db] statement_timeout: web=${web.rows[0].statement_timeout} jobs=${jobs.rows[0].statement_timeout}`,
    );
  } catch (err) {
    console.warn('[db] Could not read statement_timeout:', err instanceof Error ? err.message : String(err));
  }
}

// Verify connection at startup — fail fast rather than surface confusing errors later.
// Retries with a short delay: Neon's serverless compute auto-suspends when idle and
// can take longer than one connection attempt to wake back up.
async function verifyConnection(attempts = 3, delayMs = 2_000): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await db.query('SELECT 1');
      if (process.env.NODE_ENV !== 'test') await reportStatementTimeouts();
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt === attempts) {
        logger.error(`[db] Connection failed after ${attempts} attempts`, err);
        // Give Sentry a moment to send the report before exiting.
        await Sentry.flush(2000);
        process.exit(1);
      }
      console.warn(`[db] Connection attempt ${attempt}/${attempts} failed (${message}), retrying...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

void verifyConnection();

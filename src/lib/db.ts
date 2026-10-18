import { Pool, PoolConfig } from 'pg';
import dotenv from 'dotenv';

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
  // Server-side cap on any one statement (sent as a startup parameter; Neon's
  // pooled endpoint accepts it).
  statement_timeout: 10_000,
  // Client-side cap: rejects the query promise if the server hasn't answered.
  query_timeout: 15_000,
};

export const db = new Pool(config);

// An idle client can error (e.g. the server drops the connection). With no
// listener, pg re-emits it as an uncaught exception and the process dies.
db.on('error', (err) => {
  console.error('[db] Idle client error:', err.message);
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
  statement_timeout: 5 * 60_000,
  query_timeout: undefined,
});

jobDb.on('error', (err) => {
  console.error('[db] Idle job client error:', err.message);
});

// Verify connection at startup — fail fast rather than surface confusing errors later.
// Retries with a short delay: Neon's serverless compute auto-suspends when idle and
// can take longer than one connection attempt to wake back up.
async function verifyConnection(attempts = 3, delayMs = 2_000): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await db.query('SELECT 1');
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt === attempts) {
        console.error(`[db] Connection failed after ${attempts} attempts:`, message);
        process.exit(1);
      }
      console.warn(`[db] Connection attempt ${attempt}/${attempts} failed (${message}), retrying...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

void verifyConnection();

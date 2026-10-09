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
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
};

export const db = new Pool(config);

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

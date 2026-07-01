import dotenv from 'dotenv';
import { Pool } from 'pg';

dotenv.config();

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

// Pre-rename fixture names that leaked into the app DB before 2026-06-30.
// These are the OLD names (without the __test__ prefix). Current test files
// use __test__-prefixed names and clean up after themselves via afterAll.
// This script is a one-off tool — safe to run multiple times (idempotent).
// Do NOT add pattern matching — only ever delete these enumerated names.
const FIXTURE_NAMES = [
  'cataloguetestnocompanionsxyz',
  'flaggedtestxyz',
  'flaggeddetailtestxyz',
  'lonelynocompanionstestxyz',
];

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const idsResult = await client.query<{ id: number }>(
      'SELECT id FROM cambium.seeds WHERE common_name = ANY($1)',
      [FIXTURE_NAMES],
    );

    const ids = idsResult.rows.map((r) => r.id);

    if (ids.length === 0) {
      console.log('No fixture seeds found. Nothing to remove.');
      await client.query('COMMIT');
      return;
    }

    console.log(`Found ${ids.length} fixture seed(s) with IDs: ${ids.join(', ')}`);

    const compResult = await client.query(
      `DELETE FROM cambium.companions
       WHERE seed_id = ANY($1::int[]) OR companion_seed_id = ANY($1::int[])`,
      [ids],
    );
    console.log(`Removed ${compResult.rowCount ?? 0} companion row(s).`);

    const seedResult = await client.query(
      'DELETE FROM cambium.seeds WHERE id = ANY($1::int[])',
      [ids],
    );
    console.log(`Removed ${seedResult.rowCount ?? 0} seed row(s).`);

    await client.query('COMMIT');
    console.log('Done.');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err: Error) => {
  console.error('clean-test-seeds failed:', err.message);
  process.exit(1);
});

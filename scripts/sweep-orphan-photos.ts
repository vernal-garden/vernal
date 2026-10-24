import dotenv from 'dotenv';
import { Pool } from 'pg';
import { listObjects } from '../src/lib/r2';
import { findOrphans } from '../src/lib/orphanPhotos';
import { queueR2Deletions } from '../src/lib/r2Cleanup';

dotenv.config();

// Finds seed and harvest photo objects in R2 that no seed_photos row or
// harvest_entries.photos element points at (and that are over 24 h old), and
// with --apply queues them in r2_deletions for the nightly job to remove.
// Dry run by default. Safe to re-run.

const apply = process.argv.includes('--apply');
const BATCH = 500;

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL must be set');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

async function main(): Promise<void> {
  const listed = [
    ...(await listObjects('seed-photos/')),
    ...(await listObjects('harvest-photos/')),
  ];

  const referenced = new Set<string>();
  const seedRows = await pool.query<{ r2_key: string | null }>('SELECT r2_key FROM seed_photos');
  for (const r of seedRows.rows) if (r.r2_key) referenced.add(r.r2_key);
  const harvestRows = await pool.query<{ key: string | null }>(
    `SELECT p->>'key' AS key FROM harvest_entries, jsonb_array_elements(photos) p`,
  );
  for (const r of harvestRows.rows) if (r.key) referenced.add(r.key);

  const orphans = findOrphans(listed, referenced, new Date());
  console.log(`Found ${orphans.length} orphaned photo object(s)`);
  for (const key of orphans) console.log(key);

  if (orphans.length === 0) return;
  if (!apply) {
    console.log('Dry run — re-run with --apply to queue them.');
    return;
  }

  for (let i = 0; i < orphans.length; i += BATCH) {
    const keys = orphans.slice(i, i + BATCH);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await queueR2Deletions(
        client,
        keys.map((path) => ({ bucket: 'public' as const, path, isPrefix: false })),
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
  console.log(`Queued ${orphans.length} for deletion; the nightly job removes them.`);
}

main()
  .then(() => pool.end())
  .catch(async (err: Error) => {
    console.error('sweep-orphan-photos failed:', err.message);
    await pool.end().catch(() => undefined);
    process.exit(1);
  });

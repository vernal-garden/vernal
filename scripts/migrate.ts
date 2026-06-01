import { Pool } from 'pg';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

async function migrate(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  });

  const client = await pool.connect();

  try {
    // Ensure the migrations tracking table exists (idempotent)
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    TEXT        PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // Load already-applied versions
    const { rows } = await client.query<{ version: string }>(
      'SELECT version FROM schema_migrations ORDER BY version',
    );
    const applied = new Set(rows.map((r) => r.version));

    // Read migration files in sorted order
    const migrationsDir = path.join(process.cwd(), 'migrations');
    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    if (files.length === 0) {
      console.log('No migration files found in migrations/');
      return;
    }

    let applied_count = 0;
    for (const file of files) {
      const version = path.basename(file, '.sql');
      if (applied.has(version)) {
        console.log(`[skip] ${version}`);
        continue;
      }

      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      console.log(`[run]  ${version} ...`);

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
        await client.query('COMMIT');
        console.log(`[ok]   ${version}`);
        applied_count++;
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`[fail] ${version}`);
        console.error(err);
        process.exit(1);
      }
    }

    if (applied_count === 0) {
      console.log('Schema is up to date.');
    } else {
      console.log(`\nApplied ${applied_count} migration(s) successfully.`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});

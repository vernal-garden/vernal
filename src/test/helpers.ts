// Shared test helpers — populated as phases add routes and DB interactions.
import fs from 'fs';
import path from 'path';
import type { Pool } from 'pg';

// Idempotent (ON CONFLICT / WHERE NOT EXISTS) — safe to call from multiple
// suites' beforeAll. Other suites (guest-access, plantings, seeds) truncate
// cambium.seeds as part of their own cleanup, so anything depending on the
// starter set must reseed itself rather than assume `npm run seed:cambium`
// output survives the rest of the run.
export async function ensureCambiumSeeded(pool: Pool): Promise<void> {
  const sql = fs.readFileSync(
    path.resolve(__dirname, '../../seeds/cambium-starter.sql'),
    'utf8',
  );
  await pool.query(sql);
}

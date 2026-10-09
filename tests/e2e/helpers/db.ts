import { Pool } from 'pg';
import * as bcrypt from 'bcrypt';

// Playwright can run multiple spec files in the same worker process (it only
// restarts the worker after a file with failures), so this module's cache —
// and this pool — can end up shared across files. Each file still calls its
// own closePool() in afterAll, so a lazily-recreated pool keeps every file
// working whether or not it happens to share a worker with another.
let pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
let ended = false;

function getPool(): Pool {
  if (ended) {
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    ended = false;
  }
  return pool;
}

export async function resetTestDb(): Promise<void> {
  await getPool().query(`
    TRUNCATE accounts, guest_sessions, gardens, beds, plantings,
             oauth_identities, password_reset_tokens
    RESTART IDENTITY CASCADE
  `);
}

export async function createTestUser(opts: {
  email?: string; password?: string;
  displayName?: string; isSupporter?: boolean;
} = {}): Promise<{ id: string; email: string; password: string }> {
  const email = opts.email ?? `test-${Date.now()}@example.com`;
  const password = opts.password ?? 'TestPass123!';
  const hash = await bcrypt.hash(password, 10);
  const result = await getPool().query<{ id: string }>(
    `INSERT INTO accounts (email, password_hash, display_name, zone, zone_location_label,
       email_verified, subscription_tier)
     VALUES ($1, $2, $3, '7b', 'Test City', true, $4) RETURNING id::text`,
    [email, hash, opts.displayName ?? 'Test User',
     opts.isSupporter ? 'supporter' : 'free']
  );
  return { id: result.rows[0].id, email, password };
}

export async function createTestGarden(accountId: string, name = 'Test Garden'):
    Promise<string> {
  const result = await getPool().query<{ id: string }>(
    `INSERT INTO gardens (owner_id, name, style, zone)
     VALUES ($1, $2, 'grid', '7b') RETURNING id::text`,
    [accountId, name]
  );
  return result.rows[0].id;
}

export async function createTestSeed(accountId: string,
    commonName = 'Test Basil'): Promise<number> {
  const result = await getPool().query<{ id: number }>(
    `INSERT INTO seeds (owner_id, common_name, origin)
     VALUES ($1, $2, 'user_created') RETURNING id`,
    [accountId, commonName]
  );
  return result.rows[0].id;
}

export async function closePool(): Promise<void> {
  if (ended) return;
  ended = true;
  await pool.end();
}

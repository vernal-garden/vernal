import { Pool, PoolConfig } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required');
}

const config: PoolConfig = {
  connectionString: process.env.DATABASE_URL,
  // SSL is required for Neon; set DATABASE_SSL=false only for local dev without SSL
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
};

export const db = new Pool(config);

// Verify connection at startup — fail fast rather than surface confusing errors later
db.query('SELECT 1').catch((err: Error) => {
  console.error('[db] Connection failed:', err.message);
  process.exit(1);
});

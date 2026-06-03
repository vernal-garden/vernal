import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { Pool } from 'pg';

dotenv.config();

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    const sql = fs.readFileSync(
      path.resolve(__dirname, '../seeds/cambium-starter.sql'),
      'utf8',
    );
    console.log('Seeding Cambium starter data...');
    await client.query(sql);
    console.log('Done.');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err: Error) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});

import { describe, it, expect, afterAll } from 'vitest';
import { Pool } from 'pg';
import { withinCap } from './limits';

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
afterAll(() => pool.end());

async function account(): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO accounts (email, zone, zone_location_label) VALUES ($1, '7b', 'Test') RETURNING id`,
    [`limits-${Date.now()}-${Math.random()}@example.com`],
  );
  return rows[0].id;
}

async function addGardens(ownerId: number, n: number) {
  await pool.query(
    `INSERT INTO gardens (owner_id, name, style, zone)
     SELECT $1, 'g' || g, 'grid', '7b' FROM generate_series(1, $2) g`,
    [ownerId, n],
  );
}

const gardenCap = (ownerId: number, max: number, adding?: number) => ({
  lockSql: 'SELECT 1 FROM accounts WHERE id = $1 FOR NO KEY UPDATE',
  countSql: 'SELECT COUNT(*)::int AS n FROM gardens WHERE owner_id = $1',
  params: [ownerId],
  max,
  adding,
});

describe('withinCap', () => {
  it('allows up to max and refuses past it', async () => {
    const id = await account();
    await addGardens(id, 2);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      expect(await withinCap(client, gardenCap(id, 3))).toBe('ok');
      expect(await withinCap(client, gardenCap(id, 2))).toBe('full');
      expect(await withinCap(client, gardenCap(id, 4, 3))).toBe('full');
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it("returns 'missing' when the parent row is missing", async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      expect(await withinCap(client, gardenCap(-1, 10))).toBe('missing');
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('throws when lockSql is not FOR NO KEY UPDATE', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await expect(
        withinCap(client, { ...gardenCap(-1, 10), lockSql: 'SELECT 1 FROM accounts WHERE id = $1 FOR UPDATE' }),
      ).rejects.toThrow(/FOR NO KEY UPDATE/);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});

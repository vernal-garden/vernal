import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import app from '../index';

// TEST_DATABASE_URL is validated by src/test/setup.ts before this file runs.
const url = process.env.TEST_DATABASE_URL as string;

const pool = new Pool({
  connectionString: url,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

let tomatoId: number;
const insertedIds: number[] = [];

beforeAll(async () => {
  const res = await pool.query<{ id: number }>(
    "SELECT id FROM cambium.seeds WHERE common_name = 'Tomato' AND moderation_status = 'active'",
  );
  if (res.rows.length === 0) {
    throw new Error('Cambium seed data not found. Run: npm run seed:cambium');
  }
  tomatoId = res.rows[0].id;
});

afterAll(async () => {
  try {
    if (insertedIds.length > 0) {
      await pool.query(
        `DELETE FROM cambium.companions
         WHERE seed_id = ANY($1::int[]) OR companion_seed_id = ANY($1::int[])`,
        [insertedIds],
      );
      await pool.query('DELETE FROM cambium.seeds WHERE id = ANY($1::int[])', [insertedIds]);
    }
    // Safety net: catch any leftovers regardless of ID tracking
    await pool.query(`DELETE FROM cambium.seeds WHERE common_name LIKE '\\_\\_test\\_\\_%' ESCAPE '\\'`);
  } finally {
    await pool.end();
  }
});

describe('GET /api/catalogue/seeds', () => {
  it('returns matching seeds for text query', async () => {
    const res = await request(app).get('/api/catalogue/seeds?q=tomato');
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThan(0);
    expect(res.body.data[0].commonName).toContain('Tomato');
  });

  it('browse with no query returns all seeds ordered by commonName', async () => {
    const res = await request(app).get('/api/catalogue/seeds');
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(12);
  });

  it('filters by family', async () => {
    const res = await request(app).get('/api/catalogue/seeds?family=Solanaceae');
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThan(0);
  });

  it('respects limit parameter', async () => {
    const res = await request(app).get('/api/catalogue/seeds?limit=3');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeLessThanOrEqual(3);
  });

  it('sort=popular returns 200 with seed list', async () => {
    const res = await request(app).get('/api/catalogue/seeds?sort=popular&limit=5');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(typeof res.body.total).toBe('number');
  });

  it('unknown sort value is silently ignored (returns 200)', async () => {
    const res = await request(app).get('/api/catalogue/seeds?sort=invalid');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});

describe('GET /api/catalogue/seeds/:id', () => {
  it('returns seed detail for valid id', async () => {
    const res = await request(app).get(`/api/catalogue/seeds/${tomatoId}`);
    expect(res.status).toBe(200);
    expect(res.body.commonName).toBe('Tomato');
    expect(typeof res.body.maturityDaysMin === 'number' || res.body.maturityDaysMin === null).toBe(
      true,
    );
  });

  it('returns 404 for unknown id', async () => {
    const res = await request(app).get('/api/catalogue/seeds/999999');
    expect(res.status).toBe(404);
    expect(res.body.error).toBeDefined();
  });

  it('returns 400 for non-numeric id', async () => {
    const res = await request(app).get('/api/catalogue/seeds/abc');
    expect(res.status).toBe(400);
  });
});

describe('GET /api/catalogue/seeds/:id/companions', () => {
  it('returns companions for valid id', async () => {
    const res = await request(app).get(`/api/catalogue/seeds/${tomatoId}/companions`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    res.body.data.forEach((c: { confidence: number }) => {
      expect(c.confidence).toBeGreaterThanOrEqual(40);
    });
  });

  it('filters by relationship=beneficial', async () => {
    const res = await request(app).get(
      `/api/catalogue/seeds/${tomatoId}/companions?relationship=beneficial`,
    );
    expect(res.status).toBe(200);
    res.body.data.forEach((c: { relationship: string }) => {
      expect(c.relationship).toBe('beneficial');
    });
  });

  it('returns 400 for invalid relationship value', async () => {
    const res = await request(app).get(
      `/api/catalogue/seeds/${tomatoId}/companions?relationship=bogus`,
    );
    expect(res.status).toBe(400);
  });

  it('returns 404 for unknown seed id', async () => {
    const res = await request(app).get('/api/catalogue/seeds/999999/companions');
    expect(res.status).toBe(404);
  });

  it('returns 400 for non-numeric companion seed id', async () => {
    const res = await request(app).get('/api/catalogue/seeds/abc/companions');
    expect(res.status).toBe(400);
  });

  it('returns 200 with empty data array for seed with no companions', async () => {
    await pool.query(`DELETE FROM cambium.seeds WHERE common_name = '__test__cataloguetestnocompanionsxyz'`);
    const insertRes = await pool.query<{ id: number }>(
      `INSERT INTO cambium.seeds (common_name, moderation_status, source)
       VALUES ('__test__cataloguetestnocompanionsxyz', 'active', 'editorial')
       RETURNING id`,
    );
    const newId = insertRes.rows[0].id;
    insertedIds.push(newId);

    const res = await request(app).get(`/api/catalogue/seeds/${newId}/companions`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});

describe('GET /api/catalogue/families', () => {
  it('returns families with positive counts', async () => {
    const res = await request(app).get('/api/catalogue/families');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
    res.body.data.forEach((f: { count: number }) => {
      expect(f.count).toBeGreaterThan(0);
    });
  });
});

describe('trust proxy', () => {
  it('trusts exactly one proxy hop (rate limiting keys per client IP)', () => {
    expect(app.get('trust proxy')).toBe(1);
  });
});

describe('rate limiting', () => {
  it('returns 429 after exceeding rate limit', async () => {
    const responses = await Promise.all(
      Array.from({ length: 61 }, () => request(app).get('/api/catalogue/seeds?q=x')),
    );
    const statuses = responses.map((r) => r.status);
    expect(statuses.some((s) => s === 429)).toBe(true);
  });
});

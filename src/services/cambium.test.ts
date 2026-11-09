import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { searchSeeds, getSeedById, listFamilies, getCompanionsForSeed } from './cambium';
import { ensureCambiumSeeded } from '../test/helpers';
import { dbConnectionString, dbSslConfig } from '../lib/dbSsl';

// TEST_DATABASE_URL is validated by src/test/setup.ts before this file runs.
const url = process.env.TEST_DATABASE_URL as string;

const pool = new Pool({
  connectionString: dbConnectionString(url),
  ssl: dbSslConfig(),
});

// Seeds itself (idempotent) rather than assuming npm run seed:cambium output
// survives — other suites truncate cambium.seeds as part of their own cleanup.
// The starter set inserts 12 active seeds including 'Tomato'.

let tomatoId: number;
const insertedIds: number[] = [];

beforeAll(async () => {
  await ensureCambiumSeeded(pool);
  const result = await pool.query<{ id: number }>(
    "SELECT id FROM cambium.seeds WHERE common_name = 'Tomato' AND moderation_status = 'active'",
  );
  if (result.rows.length === 0) {
    throw new Error('Cambium seed data not found. Run: npm run seed:cambium');
  }
  tomatoId = result.rows[0].id;
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

describe('searchSeeds', () => {
  it('returns matching seeds for a text query', async () => {
    const result = await searchSeeds({ query: 'tomato' });
    expect(result.total).toBeGreaterThan(0);
    expect(result.data[0].commonName).toContain('Tomato');
  });

  it('returns all seeds with no query', async () => {
    const result = await searchSeeds({});
    expect(result.total).toBeGreaterThanOrEqual(12);
    // Verify ordered by commonName
    const names = result.data.map((s) => s.commonName);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sorted);
  });

  it('filters by family', async () => {
    const result = await searchSeeds({ family: 'Solanaceae' });
    expect(result.data.length).toBeGreaterThan(0);
    result.data.forEach((s) => {
      expect(s.plantFamily).toBe('Solanaceae');
    });
  });

  it('excludes seeds with moderation_status != active', async () => {
    await pool.query(`DELETE FROM cambium.seeds WHERE common_name = '__test__flaggedtestxyz'`);
    const res = await pool.query<{ id: number }>(
      `INSERT INTO cambium.seeds (common_name, moderation_status, source)
       VALUES ('__test__flaggedtestxyz', 'flagged', 'editorial')
       RETURNING id`,
    );
    insertedIds.push(res.rows[0].id);
    const result = await searchSeeds({ query: '__test__flaggedtestxyz' });
    expect(result.data).toHaveLength(0);
  });

  it('orders by aggregate_rating DESC NULLS LAST when sort=popular and no query', async () => {
    const result = await searchSeeds({ sort: 'popular', limit: 50 });
    expect(result.total).toBeGreaterThan(0);
    expect(Array.isArray(result.data)).toBe(true);
    // NULLS LAST: once a null rating appears, no non-null rating may follow
    let encounteredNull = false;
    for (const seed of result.data) {
      if (seed.aggregateRating === null) {
        encounteredNull = true;
      } else {
        expect(encounteredNull).toBe(false);
      }
    }
  });
});

describe('listFamilies', () => {
  it('returns families with positive counts', async () => {
    const families = await listFamilies();
    expect(families.length).toBeGreaterThan(0);
    families.forEach((f) => {
      expect(f.count).toBeGreaterThan(0);
    });
  });
});

describe('getSeedById', () => {
  it('returns full seed detail for a valid id', async () => {
    const seed = await getSeedById(tomatoId);
    expect(seed).not.toBeNull();
    expect(seed!.commonName).toBe('Tomato');
    expect(seed!.maturityDaysMin).not.toBeUndefined();
    expect(seed!.maturityDaysMax).not.toBeUndefined();
    expect(seed!.companions.length).toBeGreaterThan(0);
  });

  it('returns null for an unknown id', async () => {
    const seed = await getSeedById(999999);
    expect(seed).toBeNull();
  });

  it('excludes flagged seed from detail lookup', async () => {
    await pool.query(`DELETE FROM cambium.seeds WHERE common_name = '__test__flaggeddetailtestxyz'`);
    const res = await pool.query<{ id: number }>(
      `INSERT INTO cambium.seeds (common_name, moderation_status, source)
       VALUES ('__test__flaggeddetailtestxyz', 'flagged', 'editorial')
       RETURNING id`,
    );
    const flaggedId = res.rows[0].id;
    insertedIds.push(flaggedId);
    const seed = await getSeedById(flaggedId);
    expect(seed).toBeNull();
  });
});

describe('getCompanionsForSeed', () => {
  it('returns null for unknown seed', async () => {
    const result = await getCompanionsForSeed(999999);
    expect(result).toBeNull();
  });

  it('returns empty array for seed with no qualifying companions', async () => {
    await pool.query(`DELETE FROM cambium.seeds WHERE common_name = '__test__lonelynocompanionstestxyz'`);
    const res = await pool.query<{ id: number }>(
      `INSERT INTO cambium.seeds (common_name, moderation_status, source)
       VALUES ('__test__lonelynocompanionstestxyz', 'active', 'editorial')
       RETURNING id`,
    );
    const newId = res.rows[0].id;
    insertedIds.push(newId);
    const result = await getCompanionsForSeed(newId);
    expect(result).toEqual([]);
  });

  it('all returned companions have confidence >= 40', async () => {
    const companions = await getCompanionsForSeed(tomatoId);
    expect(companions).not.toBeNull();
    companions!.forEach((c) => {
      expect(c.confidence).toBeGreaterThanOrEqual(40);
    });
  });

  it('relationship filter returns only matching type', async () => {
    const companions = await getCompanionsForSeed(tomatoId, { relationship: 'beneficial' });
    expect(companions).not.toBeNull();
    companions!.forEach((c) => {
      expect(c.relationship).toBe('beneficial');
    });
  });

  describe('pair rule', () => {
    async function makeSeed(name: string, status: 'active' | 'flagged' = 'active'): Promise<number> {
      const fullName = `__test__pair_${name}`;
      await pool.query('DELETE FROM cambium.seeds WHERE common_name = $1', [fullName]);
      const res = await pool.query<{ id: number }>(
        `INSERT INTO cambium.seeds (common_name, moderation_status, source)
         VALUES ($1, $2, 'editorial')
         RETURNING id`,
        [fullName, status],
      );
      insertedIds.push(res.rows[0].id);
      return res.rows[0].id;
    }

    async function makeRow(
      seedId: number,
      companionSeedId: number,
      relationship: 'beneficial' | 'antagonistic' | 'neutral',
      confidence = 80,
    ): Promise<void> {
      await pool.query(
        `INSERT INTO cambium.companions (seed_id, companion_seed_id, relationship, confidence)
         VALUES ($1, $2, $3, $4)`,
        [seedId, companionSeedId, relationship, confidence],
      );
    }

    async function relationOf(seedId: number, neighbourId: number): Promise<string | undefined> {
      const list = await getCompanionsForSeed(seedId);
      return list!.find((c) => c.seed.id === String(neighbourId))?.relationship;
    }

    it('includes a neighbour that only has a reverse-direction row', async () => {
      const a = await makeSeed('reverse_a');
      const b = await makeSeed('reverse_b');
      await makeRow(b, a, 'beneficial');
      expect(await relationOf(a, b)).toBe('beneficial');
    });

    it('resolves a disagreeing pair as antagonistic in both lists', async () => {
      const a = await makeSeed('disagree_a');
      const b = await makeSeed('disagree_b');
      await makeRow(a, b, 'antagonistic');
      await makeRow(b, a, 'beneficial');
      expect(await relationOf(a, b)).toBe('antagonistic');
      expect(await relationOf(b, a)).toBe('antagonistic');
    });

    it('resolves antagonistic one way and neutral the other as antagonistic', async () => {
      const a = await makeSeed('antneutral_a');
      const b = await makeSeed('antneutral_b');
      await makeRow(a, b, 'antagonistic');
      await makeRow(b, a, 'neutral');
      expect(await relationOf(a, b)).toBe('antagonistic');
      expect(await relationOf(b, a)).toBe('antagonistic');
    });

    it('resolves neutral both ways as neutral', async () => {
      const a = await makeSeed('neutralboth_a');
      const b = await makeSeed('neutralboth_b');
      await makeRow(a, b, 'neutral');
      await makeRow(b, a, 'neutral');
      expect(await relationOf(a, b)).toBe('neutral');
      expect(await relationOf(b, a)).toBe('neutral');
    });

    it('resolves beneficial one way and neutral the other as beneficial', async () => {
      const a = await makeSeed('benneutral_a');
      const b = await makeSeed('benneutral_b');
      await makeRow(a, b, 'beneficial');
      await makeRow(b, a, 'neutral');
      expect(await relationOf(a, b)).toBe('beneficial');
      expect(await relationOf(b, a)).toBe('beneficial');
    });

    it('lists each neighbour once when rows exist in both directions', async () => {
      const a = await makeSeed('once_a');
      const b = await makeSeed('once_b');
      await makeRow(a, b, 'beneficial');
      await makeRow(b, a, 'beneficial', 60);
      const listA = await getCompanionsForSeed(a);
      const listB = await getCompanionsForSeed(b);
      expect(listA!.filter((c) => c.seed.id === String(b))).toHaveLength(1);
      expect(listB!.filter((c) => c.seed.id === String(a))).toHaveLength(1);
    });

    it('ignores a row below the confidence threshold', async () => {
      const a = await makeSeed('threshold_a');
      const b = await makeSeed('threshold_b');
      await makeRow(a, b, 'beneficial', 80);
      await makeRow(b, a, 'antagonistic', 39);
      expect(await relationOf(a, b)).toBe('beneficial');
      expect(await relationOf(b, a)).toBe('beneficial');
    });

    it('excludes an inactive neighbour on the reverse side', async () => {
      const a = await makeSeed('inactive_a');
      const b = await makeSeed('inactive_b', 'flagged');
      await makeRow(b, a, 'beneficial');
      expect(await relationOf(a, b)).toBeUndefined();
    });

    it('applies the relationship filter after resolving the pair', async () => {
      const a = await makeSeed('filter_a');
      const b = await makeSeed('filter_b');
      await makeRow(a, b, 'antagonistic');
      await makeRow(b, a, 'beneficial');
      const beneficial = await getCompanionsForSeed(a, { relationship: 'beneficial' });
      const antagonistic = await getCompanionsForSeed(a, { relationship: 'antagonistic' });
      expect(beneficial!.some((c) => c.seed.id === String(b))).toBe(false);
      expect(antagonistic!.some((c) => c.seed.id === String(b))).toBe(true);
    });
  });
});

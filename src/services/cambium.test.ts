import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { searchPlants, getPlantBySlug, listTags } from './cambium';

const pool = new Pool({
  connectionString: process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

// Assumes npm run seed:cambium has been run against the test database.
// The seed inserts 12 published plants including 'solanum-lycopersicum' (Tomato).

beforeAll(async () => {
  const result = await pool.query(
    'SELECT COUNT(*) AS count FROM cambium.plants WHERE is_published = true',
  );
  if (parseInt(result.rows[0].count, 10) === 0) {
    throw new Error('Cambium seed data not found. Run: npm run seed:cambium');
  }
});

afterAll(() => pool.end());

describe('searchPlants', () => {
  it('returns matching plants for a text query', async () => {
    const result = await searchPlants({ query: 'tomato' });
    expect(result.total).toBeGreaterThan(0);
    expect(result.data[0].botanicalName).toContain('Solanum');
  });

  it('returns results for a broad query', async () => {
    const result = await searchPlants({ query: '%' });
    expect(result.total).toBeGreaterThanOrEqual(12);
  });

  it('filters by tag slug', async () => {
    const result = await searchPlants({ query: '%', tagSlug: 'vegetable' });
    expect(result.total).toBeGreaterThan(0);
    result.data.forEach((p) => {
      expect(p.tags.some((t) => t.slug === 'vegetable')).toBe(true);
    });
  });

  it('respects limit and offset', async () => {
    const page1 = await searchPlants({ query: '%', limit: 3, offset: 0 });
    const page2 = await searchPlants({ query: '%', limit: 3, offset: 3 });
    expect(page1.data).toHaveLength(3);
    expect(page2.data[0].id).not.toBe(page1.data[0].id);
  });

  it('excludes unpublished plants', async () => {
    await pool.query(
      `INSERT INTO cambium.plants (slug, botanical_name, common_names, genus, species, is_published)
       VALUES ('test-unpublished', 'Test unpublishedus', ARRAY['Test Hidden Plant'], 'Test', 'unpublishedus', false)
       ON CONFLICT DO NOTHING`,
    );
    const result = await searchPlants({ query: 'hidden' });
    expect(result.data.every((p) => p.slug !== 'test-unpublished')).toBe(true);
  });
});

describe('getPlantBySlug', () => {
  it('returns full plant detail for a valid slug', async () => {
    const plant = await getPlantBySlug('solanum-lycopersicum');
    expect(plant).not.toBeNull();
    expect(plant!.slug).toBe('solanum-lycopersicum');
    expect(plant!.commonNames).toContain('Tomato');
    expect(plant!.growingAttributes).not.toBeNull();
    expect(plant!.soilPreferences).not.toBeNull();
  });

  it('returns null for an unknown slug', async () => {
    const plant = await getPlantBySlug('does-not-exist');
    expect(plant).toBeNull();
  });

  it('only returns companions above the confidence threshold', async () => {
    const plant = await getPlantBySlug('solanum-lycopersicum');
    if (plant!.companions.length > 0) {
      plant!.companions.forEach((c) => {
        expect(c.confidence).toBeGreaterThanOrEqual(40);
      });
    }
  });
});

describe('listTags', () => {
  it('returns tags with counts', async () => {
    const tags = await listTags();
    expect(tags.length).toBeGreaterThan(0);
    tags.forEach((t) => {
      expect(typeof t.slug).toBe('string');
      expect(t.count).toBeGreaterThan(0);
    });
  });
});

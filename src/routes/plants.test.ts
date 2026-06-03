import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../index';

describe('GET /api/plants', () => {
  it('returns matching plants for a text query', async () => {
    const res = await request(app).get('/api/plants?q=tomato');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.total).toBeGreaterThan(0);
    expect(res.body.data[0].botanicalName).toContain('Solanum');
  });

  it('returns all published plants with no query', async () => {
    const res = await request(app).get('/api/plants');
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(12);
  });

  it('filters by tag', async () => {
    const res = await request(app).get('/api/plants?tag=vegetable');
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThan(0);
  });

  it('respects limit parameter (max 50)', async () => {
    const res = await request(app).get('/api/plants?limit=3');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeLessThanOrEqual(3);
  });

});

describe('GET /api/plants/tags', () => {
  it('returns tags with counts', async () => {
    const res = await request(app).get('/api/plants/tags');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(typeof res.body.data[0].count).toBe('number');
  });
});

describe('GET /api/plants/:slug', () => {
  it('returns full plant detail for a valid slug', async () => {
    const res = await request(app).get('/api/plants/solanum-lycopersicum');
    expect(res.status).toBe(200);
    expect(res.body.slug).toBe('solanum-lycopersicum');
    expect(res.body.commonNames).toContain('Tomato');
  });

  it('returns 404 for an unknown slug', async () => {
    const res = await request(app).get('/api/plants/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error).toBeDefined();
  });

  it('returns 400 for an invalid slug format', async () => {
    const res = await request(app).get('/api/plants/INVALID%20SLUG');
    expect(res.status).toBe(400);
  });
});

describe('rate limiting', () => {
  it('returns 429 after exceeding rate limit', async () => {
    // Note: rate limiter is per-IP and resets every minute —
    // this test may be flaky in CI if other tests share the same window.
    const responses = await Promise.all(
      Array.from({ length: 61 }, () => request(app).get('/api/plants?q=x')),
    );
    const statuses = responses.map((r) => r.status);
    expect(statuses.some((s) => s === 429)).toBe(true);
  });
});

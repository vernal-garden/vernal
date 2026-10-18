import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { makeDbBackpressure } from './dbBackpressure';

function appWith(waiting: number) {
  const app = express();
  app.use(makeDbBackpressure(() => waiting, 50));
  app.get('/x', (_req, res) => res.json({ ok: true }));
  return app;
}

describe('makeDbBackpressure', () => {
  it('passes requests through at the threshold', async () => {
    expect((await request(appWith(50)).get('/x')).status).toBe(200);
  });

  it('returns 503 with Retry-After above the threshold', async () => {
    const res = await request(appWith(51)).get('/x');
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('5');
    expect(res.body.error).toMatch(/busy/i);
  });
});

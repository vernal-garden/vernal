import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { requestMetricsMiddleware, getRequestMetrics, resetRequestMetrics } from './requestMetrics';

function makeApp() {
  const app = express();
  app.use(requestMetricsMiddleware);
  app.get('/api/ok', (_req, res) => res.json({ ok: true }));
  app.get('/api/boom', (_req, res) => res.status(500).json({ error: 'boom' }));
  app.get('/health', (_req, res) => res.json({ ok: true }));
  return app;
}

function currentHour() {
  const { hours } = getRequestMetrics();
  return hours[hours.length - 1];
}

describe('requestMetrics', () => {
  beforeEach(() => resetRequestMetrics());

  it('records /api requests in the current hour bucket', async () => {
    const app = makeApp();
    await request(app).get('/api/ok');
    await request(app).get('/api/ok');

    const hour = currentHour();
    const expectedStart = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000).toISOString();
    expect(hour.hourStart).toBe(expectedStart);
    expect(hour.count).toBe(2);
    expect(hour.errors5xx).toBe(0);
    expect(hour.p50Ms).not.toBeNull();
  });

  it('counts a 500 response in errors5xx', async () => {
    const app = makeApp();
    await request(app).get('/api/ok');
    await request(app).get('/api/boom');

    const hour = currentHour();
    expect(hour.count).toBe(2);
    expect(hour.errors5xx).toBe(1);
  });

  it('does not record non-/api paths', async () => {
    const app = makeApp();
    await request(app).get('/health');

    expect(currentHour().count).toBe(0);
  });
});

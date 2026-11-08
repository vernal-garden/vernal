import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { makeSameOriginGuard } from './sameOrigin';

function testApp() {
  const app = express();
  app.use('/api', makeSameOriginGuard(['https://vernal.example']));
  app.post('/api/auth/login', (_req, res) => res.json({ ok: true }));
  app.get('/api/auth/oauth/google/callback', (_req, res) => res.json({ ok: true }));
  app.post('/api/webhooks/stripe', (_req, res) => res.json({ ok: true }));
  return app;
}

const REFUSED = { error: 'Cross-site request refused.' };

describe('makeSameOriginGuard', () => {
  it('refuses a POST the browser marks cross-site', async () => {
    const res = await request(testApp()).post('/api/auth/login').set('Sec-Fetch-Site', 'cross-site');
    expect(res.status).toBe(403);
    expect(res.body).toEqual(REFUSED);
  });

  it('refuses a POST from a foreign Origin, and a null Origin', async () => {
    for (const origin of ['https://evil.example', 'null', 'https://vernal.example.evil.test']) {
      const res = await request(testApp()).post('/api/auth/login').set('Origin', origin);
      expect(res.status).toBe(403);
      expect(res.body).toEqual(REFUSED);
    }
  });

  it('refuses PUT, PATCH and DELETE the same way', async () => {
    const app = express();
    app.use('/api', makeSameOriginGuard(['https://vernal.example']));
    app.all('/api/x', (_req, res) => res.json({ ok: true }));
    for (const method of ['put', 'patch', 'delete'] as const) {
      expect((await request(app)[method]('/api/x').set('Origin', 'https://evil.example')).status).toBe(403);
    }
  });

  it('passes a same-origin request from the allowed origin', async () => {
    const res = await request(testApp())
      .post('/api/auth/login')
      .set('Origin', 'https://vernal.example')
      .set('Sec-Fetch-Site', 'same-origin');
    expect(res.status).toBe(200);
  });

  it('passes a request with neither header (curl, server-to-server)', async () => {
    expect((await request(testApp()).post('/api/auth/login')).status).toBe(200);
  });

  it('leaves GETs alone, including the Google callback arriving from Google', async () => {
    const res = await request(testApp())
      .get('/api/auth/oauth/google/callback?code=x')
      .set('Sec-Fetch-Site', 'cross-site')
      .set('Origin', 'https://accounts.google.com');
    expect(res.status).toBe(200);
  });

  it('exempts the Stripe webhook', async () => {
    const res = await request(testApp())
      .post('/api/webhooks/stripe')
      .set('Sec-Fetch-Site', 'cross-site')
      .set('Origin', 'https://stripe.example');
    expect(res.status).toBe(200);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import request from 'supertest';
import app from '../index';

describe('body size cap', () => {
  it('rejects a JSON body over 64kb with 413', async () => {
    const res = await request(app)
      .post('/api/feedback')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ category: 'bug', message: 'x'.repeat(80 * 1024) }));
    expect(res.status).toBe(413);
  });

  it('accepts a normal-sized body', async () => {
    const res = await request(app)
      .post('/api/feedback')
      .send({ category: 'bug', message: 'x'.repeat(1000) });
    expect(res.status).not.toBe(413);
  });
});

function signedCookie(token: string): string {
  const sig = crypto.createHmac('sha256', process.env.SESSION_SECRET!).update(token).digest('hex');
  return `_vernal_sid=${encodeURIComponent(`${token}.${sig}`)}`;
}

describe('global API limiter wiring', () => {
  beforeEach(() => {
    process.env.ENFORCE_RATE_LIMITS = 'true';
  });
  afterEach(() => {
    delete process.env.ENFORCE_RATE_LIMITS;
  });

  it('applies the 300/min IP bucket to /api without a session', async () => {
    const res = await request(app).get('/api/does-not-exist').set('X-Forwarded-For', '192.0.2.10');
    expect(res.status).toBe(404);
    expect(res.headers['ratelimit-limit']).toBe('300');
  });

  it('applies the 600/min session bucket with a signed cookie', async () => {
    const res = await request(app)
      .get('/api/does-not-exist')
      .set('X-Forwarded-For', '192.0.2.11')
      .set('Cookie', signedCookie('f'.repeat(64)));
    expect(res.status).toBe(404);
    expect(res.headers['ratelimit-limit']).toBe('600');
  });

  it('does not limit /health', async () => {
    const res = await request(app).get('/health').set('X-Forwarded-For', '192.0.2.12');
    expect(res.headers['ratelimit-limit']).toBeUndefined();
  });

  it('does not limit the Stripe webhook', async () => {
    const res = await request(app)
      .post('/api/webhooks/stripe')
      .set('X-Forwarded-For', '192.0.2.13')
      .set('Content-Type', 'application/json')
      .send('{}');
    expect(res.status).toBe(400);
    expect(res.headers['ratelimit-limit']).toBeUndefined();
  });
});

describe('guest creation limiter', () => {
  beforeEach(() => {
    process.env.ENFORCE_RATE_LIMITS = 'true';
  });
  afterEach(() => {
    delete process.env.ENFORCE_RATE_LIMITS;
  });

  it('allows 30 new guests per IP per hour, then 429', async () => {
    let lastCookie: string[] = [];
    for (let i = 0; i < 30; i++) {
      const res = await request(app).post('/api/auth/guest').set('X-Forwarded-For', '192.0.2.20');
      expect(res.status).toBe(201);
      lastCookie = res.headers['set-cookie'] as unknown as string[];
    }
    const blocked = await request(app).post('/api/auth/guest').set('X-Forwarded-For', '192.0.2.20');
    expect(blocked.status).toBe(429);

    // A visitor who already has a session is not counted or blocked.
    const existing = await request(app)
      .post('/api/auth/guest')
      .set('X-Forwarded-For', '192.0.2.20')
      .set('Cookie', lastCookie);
    expect(existing.status).toBe(200);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { makeApiLimiters, consumeResetEmailQuota, clearResetEmailQuota } from './rateLimiters';

function signed(token: string): string {
  const sig = crypto.createHmac('sha256', process.env.SESSION_SECRET!).update(token).digest('hex');
  return `_vernal_sid=${encodeURIComponent(`${token}.${sig}`)}`;
}

function limitedApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(cookieParser());
  app.use(makeApiLimiters({ sessionMax: 3, ipMax: 2, ceilingMax: 5, windowMs: 60_000 }));
  app.get('/x', (_req, res) => res.json({ ok: true }));
  return app;
}

async function hit(app: express.Express, ip: string, cookie?: string) {
  const r = request(app).get('/x').set('X-Forwarded-For', ip);
  return (cookie ? r.set('Cookie', cookie) : r).then((res) => res.status);
}

describe('makeApiLimiters', () => {
  it('limits requests without a session by IP', async () => {
    const app = limitedApp();
    expect([await hit(app, '198.51.100.1'), await hit(app, '198.51.100.1')]).toEqual([200, 200]);
    expect(await hit(app, '198.51.100.1')).toBe(429);
  });

  it('gives a signed session its own, larger bucket', async () => {
    const app = limitedApp();
    const a = signed('a'.repeat(64));
    for (let i = 0; i < 3; i++) expect(await hit(app, '198.51.100.2', a)).toBe(200);
    expect(await hit(app, '198.51.100.2', a)).toBe(429);
  });

  it('treats a cookie with a bad signature as no session', async () => {
    const app = limitedApp();
    const forged = `_vernal_sid=${encodeURIComponent(`${'b'.repeat(64)}.${'0'.repeat(64)}`)}`;
    expect([await hit(app, '198.51.100.3', forged), await hit(app, '198.51.100.3', forged)]).toEqual([200, 200]);
    expect(await hit(app, '198.51.100.3', forged)).toBe(429);
  });

  it('applies the per-IP ceiling across many sessions', async () => {
    const app = limitedApp();
    for (let i = 0; i < 3; i++) expect(await hit(app, '198.51.100.4', signed('c'.repeat(64)))).toBe(200);
    for (let i = 0; i < 2; i++) expect(await hit(app, '198.51.100.4', signed('d'.repeat(64)))).toBe(200);
    expect(await hit(app, '198.51.100.4', signed('e'.repeat(64)))).toBe(429);
  });
});

describe('consumeResetEmailQuota', () => {
  beforeEach(() => {
    process.env.ENFORCE_RATE_LIMITS = 'true';
    clearResetEmailQuota();
  });
  afterEach(() => {
    delete process.env.ENFORCE_RATE_LIMITS;
    clearResetEmailQuota();
  });

  it('allows 5 per email+IP per day, then refuses', () => {
    for (let i = 0; i < 5; i++) expect(consumeResetEmailQuota('q@example.com', '192.0.2.1')).toBe(true);
    expect(consumeResetEmailQuota('q@example.com', '192.0.2.1')).toBe(false);
  });

  it('a different IP for the same email is still allowed', () => {
    for (let i = 0; i < 5; i++) consumeResetEmailQuota('p@example.com', '192.0.2.1');
    expect(consumeResetEmailQuota('p@example.com', '192.0.2.1')).toBe(false);
    expect(consumeResetEmailQuota('p@example.com', '192.0.2.2')).toBe(true);
  });

  it('caps 20 per email across IPs, even from a new IP', () => {
    for (let i = 0; i < 20; i++) expect(consumeResetEmailQuota('m@example.com', `192.0.2.${i + 10}`)).toBe(true);
    expect(consumeResetEmailQuota('m@example.com', '192.0.2.99')).toBe(false);
  });

  it('normalises case and whitespace', () => {
    for (let i = 0; i < 5; i++) expect(consumeResetEmailQuota('Mixed@Example.com', '192.0.2.1')).toBe(true);
    expect(consumeResetEmailQuota('  mixed@example.COM ', '192.0.2.1')).toBe(false);
  });

  it('frees up after 24 hours', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) consumeResetEmailQuota('w@example.com', '192.0.2.1', t0);
    expect(consumeResetEmailQuota('w@example.com', '192.0.2.1', t0 + 1000)).toBe(false);
    expect(consumeResetEmailQuota('w@example.com', '192.0.2.1', t0 + 24 * 60 * 60 * 1000 + 1)).toBe(true);
  });

  it('always allows under test unless enforcement is on', () => {
    delete process.env.ENFORCE_RATE_LIMITS;
    for (let i = 0; i < 10; i++) expect(consumeResetEmailQuota('t@example.com', '192.0.2.1')).toBe(true);
  });
});

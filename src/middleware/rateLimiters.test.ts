import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { makeApiLimiters, makeLoginLimiters, makeEventsBatchLimiter, makeWeatherTestLimiter, writeLimiterKey, consumeResetEmailQuota, clearResetEmailQuota } from './rateLimiters';

describe('makeEventsBatchLimiter', () => {
  it('allows max batches per session, then 429', async () => {
    const app = express();
    app.use((req, _res, next) => { (req as unknown as { session: unknown }).session = { id: 's-events' }; next(); });
    app.post('/b', makeEventsBatchLimiter({ max: 2, windowMs: 60_000 }), (_req, res) => res.status(204).send());
    expect((await request(app).post('/b')).status).toBe(204);
    expect((await request(app).post('/b')).status).toBe(204);
    expect((await request(app).post('/b')).status).toBe(429);
  });
});

describe('makeWeatherTestLimiter', () => {
  it('allows max per account, then 429', async () => {
    const app = express();
    app.use((req, _res, next) => { (req as unknown as { session: unknown }).session = { id: 's', account: { id: 42 } }; next(); });
    app.post('/t', makeWeatherTestLimiter({ max: 1, windowMs: 60_000 }), (_req, res) => res.json({ ok: true }));
    expect((await request(app).post('/t')).status).toBe(200);
    expect((await request(app).post('/t')).status).toBe(429);
  });
});

function loginApp(limiters = makeLoginLimiters({ ipMax: 4, pairMax: 2, emailMax: 3, windowMs: 60_000 })) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.post('/login', ...limiters.handlers, (req, res) => {
    if (req.body.password === 'right') res.json({ ok: true });
    else res.status(401).json({ error: 'Invalid email or password' });
  });
  return app;
}

function login(app: express.Express, ip: string, email: unknown, password: string) {
  return request(app).post('/login').set('X-Forwarded-For', ip).send({ email, password }).then((r) => r.status);
}

describe('makeLoginLimiters', () => {
  it('caps failures per email+IP pair; another IP can still sign in', async () => {
    const app = loginApp();
    expect(await login(app, '203.0.113.1', 'victim@example.com', 'wrong')).toBe(401);
    expect(await login(app, '203.0.113.1', 'victim@example.com', 'wrong')).toBe(401);
    expect(await login(app, '203.0.113.1', 'victim@example.com', 'right')).toBe(429);
    expect(await login(app, '203.0.113.2', 'victim@example.com', 'right')).toBe(200);
  });

  it('caps failures per email across IPs', async () => {
    const app = loginApp();
    await login(app, '203.0.113.3', 'spread@example.com', 'wrong');
    await login(app, '203.0.113.3', 'spread@example.com', 'wrong');
    await login(app, '203.0.113.4', 'spread@example.com', 'wrong');
    expect(await login(app, '203.0.113.5', 'spread@example.com', 'right')).toBe(429);
  });

  it('requests refused by the pair cap do not count towards the email cap', async () => {
    const app = loginApp();
    await login(app, '203.0.113.6', 'target@example.com', 'wrong');
    await login(app, '203.0.113.6', 'target@example.com', 'wrong');
    for (let i = 0; i < 3; i++) expect(await login(app, '203.0.113.6', 'target@example.com', 'wrong')).toBe(429);
    // Only 2 failures reached the email cap, so a third from another IP is still judged.
    expect(await login(app, '203.0.113.7', 'target@example.com', 'wrong')).toBe(401);
  });

  it('normalises the email key', async () => {
    const app = loginApp();
    await login(app, '203.0.113.8', 'Case@Example.com', 'wrong');
    await login(app, '203.0.113.8', ' case@example.com ', 'wrong');
    expect(await login(app, '203.0.113.8', 'CASE@example.com', 'right')).toBe(429);
  });

  it('successful logins do not count', async () => {
    const app = loginApp();
    for (let i = 0; i < 6; i++) expect(await login(app, '203.0.113.9', 'ok@example.com', 'right')).toBe(200);
  });

  it('limits failures per IP across many emails', async () => {
    const app = loginApp();
    for (let i = 0; i < 4; i++) expect(await login(app, '203.0.113.11', `spray${i}@example.com`, 'wrong')).toBe(401);
    expect(await login(app, '203.0.113.11', 'spray9@example.com', 'wrong')).toBe(429);
  });

  it('a non-string email is keyed by IP, not a shared bucket', async () => {
    const app = loginApp();
    await login(app, '203.0.113.12', 123, 'wrong');
    await login(app, '203.0.113.12', 123, 'wrong');
    expect(await login(app, '203.0.113.13', 123, 'wrong')).toBe(401);
  });

  it('attempts refused with 429 do not count towards any limiter', async () => {
    const app = loginApp();
    await login(app, '203.0.113.14', 'spread2@example.com', 'wrong');
    await login(app, '203.0.113.14', 'spread2@example.com', 'wrong');
    await login(app, '203.0.113.15', 'spread2@example.com', 'wrong');
    for (let i = 0; i < 4; i++) expect(await login(app, '203.0.113.16', 'spread2@example.com', 'wrong')).toBe(429);
    // The four refusals left 203.0.113.16's per-IP bucket empty, so it is still judged.
    expect(await login(app, '203.0.113.16', 'other@example.com', 'wrong')).toBe(401);
  });

  it('caps the email key at 254 characters', async () => {
    const app = loginApp();
    const base = `${'a'.repeat(250)}@example.com`;
    await login(app, '203.0.113.17', `${base}x`, 'wrong');
    await login(app, '203.0.113.17', `${base}y`, 'wrong');
    expect(await login(app, '203.0.113.17', `${base}z`, 'right')).toBe(429);
  });

  it('reset clears the pair and email buckets for that address', async () => {
    const limiters = makeLoginLimiters({ ipMax: 4, pairMax: 2, emailMax: 3, windowMs: 60_000 });
    const app = loginApp(limiters);
    await login(app, '203.0.113.18', 'locked@example.com', 'wrong');
    await login(app, '203.0.113.18', 'locked@example.com', 'wrong');
    await login(app, '203.0.113.19', 'locked@example.com', 'wrong');
    expect(await login(app, '203.0.113.18', 'locked@example.com', 'right')).toBe(429);
    expect(await login(app, '203.0.113.20', 'locked@example.com', 'right')).toBe(429);
    limiters.reset(' Locked@Example.com ', { ip: '203.0.113.18' } as unknown as import('express').Request);
    expect(await login(app, '203.0.113.18', 'locked@example.com', 'right')).toBe(200);
  });
});

describe('writeLimiterKey', () => {
  const req = (session: unknown) => ({ session, ip: '198.51.100.9' }) as unknown as import('express').Request;

  it('keys accounts by account id', () => {
    expect(writeLimiterKey(req({ id: 's1', account: { id: 7 } }))).toBe('user:7');
  });

  it('keys guests by session id', () => {
    expect(writeLimiterKey(req({ id: 's2', account: null }))).toBe('session:s2');
  });

  it('falls back to IP without a session', () => {
    expect(writeLimiterKey(req(null))).toBe('198.51.100.9');
  });
});

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

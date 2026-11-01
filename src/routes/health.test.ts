import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { readFileSync } from 'fs';
import path from 'path';
import { gzipSync } from 'zlib';

// Mock the db module before importing app so Pool is never instantiated
vi.mock('../lib/db', () => ({
  db: {
    query: vi.fn(),
    waitingCount: 0,
  },
}));

import app from '../index';
import { db } from '../lib/db';
import { checkDb, resetHealthCacheForTests } from './health';

const mockQuery = vi.mocked(db.query);

describe('GET /health', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetHealthCacheForTests();
    (db as unknown as { waitingCount: number }).waitingCount = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs one query for concurrent hits', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 } as any);
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => request(app).get('/health')));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('reuses the result for 5 seconds, then checks again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 } as any);
      await request(app).get('/health');
      vi.setSystemTime(Date.now() + 4_000);
      await request(app).get('/health');
      expect(mockQuery).toHaveBeenCalledTimes(1);
      vi.setSystemTime(Date.now() + 2_000);
      await request(app).get('/health');
      expect(mockQuery).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports degraded without querying when the pool has waiters', async () => {
    (db as unknown as { waitingCount: number }).waitingCount = 3;
    const res = await request(app).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.db).toBe('error');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('does not cache the pool-waiters result', async () => {
    (db as unknown as { waitingCount: number }).waitingCount = 3;
    expect((await request(app).get('/health')).status).toBe(503);
    (db as unknown as { waitingCount: number }).waitingCount = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 } as any);

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('reports degraded when the check takes longer than 2 seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      // Unit-level: supertest's real socket doesn't mix with fake timers.
      mockQuery.mockReturnValue(new Promise(() => {}) as never);
      const pending = checkDb();
      await vi.advanceTimersByTimeAsync(2_100);
      expect(await pending).toBe('error');
      // The timed-out query is still outstanding, so no second one is issued.
      expect(await checkDb()).toBe('error');
      expect(mockQuery).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not look up a session when a cookie is sent', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 } as any);
    const token = 'a'.repeat(64);
    const sig = crypto.createHmac('sha256', process.env.SESSION_SECRET!).update(token).digest('hex');
    await request(app).get('/health').set('Cookie', `_vernal_sid=${token}.${sig}`);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls[0][0]).toBe('SELECT 1');
  });

  it('returns 200 with db:ok when database is reachable', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.db).toBe('ok');
    expect(typeof res.body.timestamp).toBe('string');
    expect(typeof res.body.version).toBe('string');
  });

  it('reports the version from package.json', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
    const pkg = JSON.parse(readFileSync(path.join(__dirname, '../../package.json'), 'utf-8')) as { version: string };

    const res = await request(app).get('/health');

    expect(res.body.version).toBe(pkg.version);
  });

  it('returns 503 with db:error when database is unreachable', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection refused'));

    const res = await request(app).get('/health');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.db).toBe('error');
  });
});

describe('compressed request bodies', () => {
  it('rejects a gzip-encoded JSON body with 415 instead of inflating it', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'gzip')
      .send(gzipSync(JSON.stringify({ email: 'a@example.com', password: 'x' })));

    expect(res.status).toBe(415);
  });
});

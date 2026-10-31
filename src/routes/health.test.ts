import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { readFileSync } from 'fs';
import path from 'path';
import { gzipSync } from 'zlib';

// Mock the db module before importing app so Pool is never instantiated
vi.mock('../lib/db', () => ({
  db: {
    query: vi.fn(),
  },
}));

import app from '../index';
import { db } from '../lib/db';

const mockQuery = vi.mocked(db.query);

describe('GET /health', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

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
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as import('pg').QueryResult);

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.db).toBe('ok');
    expect(typeof res.body.timestamp).toBe('string');
    expect(typeof res.body.version).toBe('string');
  });

  it('returns 503 with db:error when database is unreachable', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection refused'));

    const res = await request(app).get('/health');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.db).toBe('error');
  });
});

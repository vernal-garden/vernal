import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../index';

describe('GET /health', () => {
  it('returns status ok with a timestamp', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.timestamp).toBe('string');
    expect(typeof res.body.version).toBe('string');
  });
});

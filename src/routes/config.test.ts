import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import app from '../index';
import { getServerConfig, setServerConfigForTests } from '../lib/serverConfig';

const original = getServerConfig();
afterAll(() => setServerConfigForTests(original));

describe('GET /api/config', () => {
  it('reports the loaded switches without auth', async () => {
    setServerConfigForTests({ billing: 'stripe', mail: 'smtp', media: 's3', googleSignIn: true, weather: true });
    const res = await request(app).get('/api/config');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.body).toEqual({ billing: true, mail: true, googleSignIn: true, weather: true });
  });

  it('reports everything off', async () => {
    setServerConfigForTests({ billing: 'off', mail: 'off', media: 'local', googleSignIn: false, weather: false });
    const res = await request(app).get('/api/config');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ billing: false, mail: false, googleSignIn: false, weather: false });
  });
});

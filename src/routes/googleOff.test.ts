import { describe, it, expect, afterEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import app from '../index';
import { getServerConfig, setServerConfigForTests } from '../lib/serverConfig';

const original = getServerConfig();

afterEach(() => {
  setServerConfigForTests(original);
  vi.unstubAllEnvs();
  vi.resetModules();
});
afterAll(() => setServerConfigForTests(original));

describe('Google sign-in switched off', () => {
  it('404s the OAuth start and callback routes', async () => {
    setServerConfigForTests({ ...original, googleSignIn: false });

    const start = await request(app).get('/api/auth/oauth/google');
    expect(start.status).toBe(404);
    expect(start.body).toEqual({ error: 'Not found' });
    expect(start.headers['set-cookie']).toBeUndefined();

    const callback = await request(app).get('/api/auth/oauth/google/callback?code=x&state=y');
    expect(callback.status).toBe(404);
    expect(callback.body).toEqual({ error: 'Not found' });
  });

  it('still redirects to Google when it is on', async () => {
    setServerConfigForTests({ ...original, googleSignIn: true });
    const res = await request(app).get('/api/auth/oauth/google');
    expect(res.status).toBe(302);
  });

  it('starts the app with both Google settings blank', async () => {
    vi.stubEnv('GOOGLE_CLIENT_ID', '');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', '');
    vi.resetModules();

    const { loadServerConfig } = await import('../lib/serverConfig');
    expect(loadServerConfig().googleSignIn).toBe(false);

    const freshApp = (await import('../index')).default;

    const config = await request(freshApp).get('/api/config');
    expect(config.status).toBe(200);
    expect(config.body.googleSignIn).toBe(false);

    const start = await request(freshApp).get('/api/auth/oauth/google');
    expect(start.status).toBe(404);
  });
});

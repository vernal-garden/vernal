import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import app from '../index';
import { db } from '../lib/db';
import { getServerConfig, setServerConfigForTests } from '../lib/serverConfig';
import { invalidateBetaSettings } from '../lib/beta';

const original = getServerConfig();
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const CLOSE_AT = new Date('2027-01-01T08:00:00Z');

async function resetBeta() {
  await pool.query(
    `UPDATE beta_settings
        SET gate_on = false, guest_mode_on = true, supporter_access_on = true, gate_first_on_at = NULL
      WHERE id = 1`,
  );
  invalidateBetaSettings();
}

beforeEach(resetBeta);
afterEach(() => {
  vi.useRealTimers();
  setServerConfigForTests(original);
});
afterAll(async () => {
  await resetBeta();
  await pool.end();
});

describe('GET /api/config', () => {
  it('reports the loaded switches without auth', async () => {
    setServerConfigForTests({
      billing: 'stripe', mail: 'smtp', media: 's3', googleSignIn: true, weather: true, betaApplicationsCloseAt: new Date('2100-01-01T00:00:00Z'),
    });
    const res = await request(app).get('/api/config');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.body).toEqual({
      billing: true,
      mail: true,
      googleSignIn: true,
      weather: true,
      betaGate: false,
      guestMode: true,
      privateBetaVersion: 'applications_open',
    });
  });

  it('reports everything off', async () => {
    setServerConfigForTests({
      billing: 'off', mail: 'off', media: 'local', googleSignIn: false, weather: false, betaApplicationsCloseAt: CLOSE_AT,
    });
    const res = await request(app).get('/api/config');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ billing: false, mail: false, googleSignIn: false, weather: false });
  });

  it('reports the beta switches from the database', async () => {
    await pool.query('UPDATE beta_settings SET gate_on = true, guest_mode_on = false WHERE id = 1');
    invalidateBetaSettings();
    const res = await request(app).get('/api/config');
    expect(res.body).toMatchObject({ betaGate: true, guestMode: false });
  });

  it('sends a failed settings read to the error handler', async () => {
    const spy = vi.spyOn(db, 'query').mockRejectedValueOnce(new Error('db down'));
    try {
      const res = await request(app).get('/api/config');
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Internal server error' });
    } finally {
      spy.mockRestore();
    }
  });

  describe('privateBetaVersion', () => {
    beforeEach(() => {
      setServerConfigForTests({ ...original, betaApplicationsCloseAt: CLOSE_AT });
      // Only Date is faked: timers and I/O must keep running for supertest and pg.
      vi.useFakeTimers({ toFake: ['Date'] });
    });

    it('is applications_open just before the cutoff', async () => {
      vi.setSystemTime(new Date(CLOSE_AT.getTime() - 1));
      expect((await request(app).get('/api/config')).body.privateBetaVersion).toBe('applications_open');
    });

    it('is applications_closed at the cutoff instant', async () => {
      vi.setSystemTime(CLOSE_AT);
      expect((await request(app).get('/api/config')).body.privateBetaVersion).toBe('applications_closed');
    });

    it('is applications_closed after the cutoff', async () => {
      vi.setSystemTime(new Date(CLOSE_AT.getTime() + 1));
      expect((await request(app).get('/api/config')).body.privateBetaVersion).toBe('applications_closed');
    });
  });
});

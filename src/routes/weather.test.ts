import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { Pool } from 'pg';
import app from '../index';
import { LOCATION_NOT_SET } from '../lib/constants';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL must be set to run tests');

const pool = new Pool({ connectionString: url });

async function resetDb() {
  await pool.query(
    'TRUNCATE accounts, guest_sessions, weather_connections, weather_readings RESTART IDENTITY CASCADE',
  );
}

async function createUser(
  email: string,
  tier: 'free' | 'supporter' = 'free',
  locationLabel = 'Test City',
): Promise<number> {
  const hash = await bcrypt.hash('Password123!', 4);
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO accounts
       (email, password_hash, zone, zone_location_label, email_verified, subscription_tier)
     VALUES ($1, $2, '7b', $3, true, $4)
     RETURNING id`,
    [email, hash, locationLabel, tier],
  );
  return rows[0].id;
}

async function loginAgent(email: string, password = 'Password123!') {
  const agent = request.agent(app);
  await agent.post('/api/auth/guest');
  await agent.post('/api/auth/login').send({ email, password });
  return agent;
}

function tempestFetchResponse(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    ok: true,
    json: async () => ({
      obs: [
        {
          timestamp: 1_700_000_000,
          air_temperature: 18.5,
          relative_humidity: 62,
          wind_avg: 3.2,
          wind_direction: 90,
          precip_accum_local_day: 1.4,
          uv: 5,
          sea_level_pressure: 1013.2,
          ...overrides,
        },
      ],
    }),
  };
}

function geocodeFetchResponse(lat = '45.5', lon = '-122.6') {
  return { ok: true, json: async () => [{ lat, lon }] };
}

function openMeteoCurrentResponse() {
  return {
    ok: true,
    json: async () => ({
      current: {
        time: '2026-07-11T12:00',
        temperature_2m: 22.1,
        relative_humidity_2m: 55,
        precipitation: 0.2,
        surface_pressure: 1005.3,
        wind_speed_10m: 4.1,
        wind_direction_10m: 180,
        uv_index: 6,
      },
    }),
  };
}

function openMeteoHistoryResponse() {
  const time = ['1', '2', '3', '4', '5', '6', '7'].map((d) => `2026-07-0${d}`);
  return {
    ok: true,
    json: async () => ({
      daily: {
        time,
        temperature_2m_max: time.map(() => 25),
        temperature_2m_min: time.map(() => 14),
        precipitation_sum: time.map(() => 0),
      },
    }),
  };
}

// Routes each fetch call to the right mock by URL host.
function routedFetchMock(opts: {
  tempest?: ReturnType<typeof tempestFetchResponse> | (() => ReturnType<typeof tempestFetchResponse>);
  geocode?: ReturnType<typeof geocodeFetchResponse>;
  openMeteoCurrent?: ReturnType<typeof openMeteoCurrentResponse>;
  openMeteoHistory?: ReturnType<typeof openMeteoHistoryResponse>;
}) {
  return vi.fn(async (input: string) => {
    const urlStr = String(input);
    if (urlStr.includes('weatherflow.com')) {
      const t = opts.tempest;
      if (typeof t === 'function') return t();
      if (t) return t;
      throw new Error('unexpected tempest call');
    }
    if (urlStr.includes('nominatim.openstreetmap.org')) {
      return opts.geocode ?? geocodeFetchResponse();
    }
    if (urlStr.includes('api.open-meteo.com')) {
      if (urlStr.includes('daily=')) return opts.openMeteoHistory ?? openMeteoHistoryResponse();
      return opts.openMeteoCurrent ?? openMeteoCurrentResponse();
    }
    throw new Error(`unexpected fetch: ${urlStr}`);
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Fixtures ────────────────────────────────────────────────────────────────

let freeAgent: ReturnType<typeof request.agent>;
let supporterAgent: ReturnType<typeof request.agent>;
let otherAgent: ReturnType<typeof request.agent>;
let noLocationAgent: ReturnType<typeof request.agent>;
let unreachableAgent: ReturnType<typeof request.agent>;

beforeAll(async () => {
  await resetDb();

  await createUser('weather-free@example.com', 'free');
  await createUser('weather-supporter@example.com', 'supporter', 'Portland, OR');
  await createUser('weather-other@example.com', 'supporter', 'Other City');
  await createUser('weather-nolocation@example.com', 'supporter', LOCATION_NOT_SET);
  // Distinct location so its public-weather cache entry is never warmed by
  // another test — otherwise a prior successful fetch would mask this fetch
  // failure via the shared in-memory public-current cache.
  await createUser('weather-unreachable@example.com', 'supporter', 'Unreachable City');

  freeAgent = await loginAgent('weather-free@example.com');
  supporterAgent = await loginAgent('weather-supporter@example.com');
  otherAgent = await loginAgent('weather-other@example.com');
  noLocationAgent = await loginAgent('weather-nolocation@example.com');
  unreachableAgent = await loginAgent('weather-unreachable@example.com');
});

afterAll(() => pool.end());

// ── requireSupporter gating ──────────────────────────────────────────────────

describe('access control', () => {
  it('guest → 401', async () => {
    const guest = request.agent(app);
    await guest.post('/api/auth/guest');
    const res = await guest.get('/api/weather/connections');
    expect(res.status).toBe(401);
  });

  it('free account → 402 upgrade_required', async () => {
    const res = await freeAgent.get('/api/weather/connections');
    expect(res.status).toBe(402);
    expect(res.body.upgrade_required).toBe(true);
  });

  it('supporter passes', async () => {
    const res = await supporterAgent.get('/api/weather/connections');
    expect(res.status).toBe(200);
  });
});

// ── POST /connections ────────────────────────────────────────────────────────

describe('POST /api/weather/connections', () => {
  it('creates a pws_tempest connection, response has no credentials, row stores encrypted enc', async () => {
    const res = await supporterAgent.post('/api/weather/connections').send({
      provider: 'pws_tempest',
      credentials: { accessToken: 'secret-token-123' },
      stationId: 'station-1',
    });

    expect(res.status).toBe(201);
    expect(res.body).not.toHaveProperty('credentials');
    expect(res.body.provider).toBe('pws_tempest');
    expect(res.body.stationId).toBe('station-1');
    expect(res.body.isPrimary).toBe(true);

    const { rows } = await pool.query('SELECT credentials FROM weather_connections WHERE id = $1', [res.body.id]);
    expect(rows[0].credentials).toHaveProperty('enc');
    expect(rows[0].credentials.enc).not.toContain('secret-token-123');
  });

  it('rejects public_weather with a specific message', async () => {
    const res = await supporterAgent.post('/api/weather/connections').send({
      provider: 'public_weather',
      credentials: {},
    });
    expect(res.status).toBe(400);
  });

  it('rejects an unimplemented provider', async () => {
    const res = await supporterAgent.post('/api/weather/connections').send({
      provider: 'pws_ambient',
      credentials: {},
    });
    expect(res.status).toBe(400);
  });

  it('400 when accessToken is missing', async () => {
    const res = await supporterAgent.post('/api/weather/connections').send({
      provider: 'pws_tempest',
      credentials: {},
      stationId: 'station-2',
    });
    expect(res.status).toBe(400);
  });

  it('400 when stationId is missing', async () => {
    const res = await supporterAgent.post('/api/weather/connections').send({
      provider: 'pws_tempest',
      credentials: { accessToken: 'tok' },
    });
    expect(res.status).toBe(400);
  });

  it('demotes an existing primary when a new default-primary connection is created', async () => {
    const first = await supporterAgent.post('/api/weather/connections').send({
      provider: 'pws_tempest',
      credentials: { accessToken: 'tok-a' },
      stationId: 'station-a',
    });
    const second = await supporterAgent.post('/api/weather/connections').send({
      provider: 'pws_tempest',
      credentials: { accessToken: 'tok-b' },
      stationId: 'station-b',
    });
    expect(second.body.isPrimary).toBe(true);

    const { rows } = await pool.query('SELECT is_primary FROM weather_connections WHERE id = $1', [first.body.id]);
    expect(rows[0].is_primary).toBe(false);
  });
});

// ── GET /connections ──────────────────────────────────────────────────────────

describe('GET /api/weather/connections', () => {
  it('lists connections for the account without credentials', async () => {
    const res = await supporterAgent.get('/api/weather/connections');
    expect(res.status).toBe(200);
    expect(res.body.data).toBeInstanceOf(Array);
    for (const conn of res.body.data) {
      expect(conn).not.toHaveProperty('credentials');
    }
  });
});

// ── DELETE /connections/:id ───────────────────────────────────────────────────

describe('DELETE /api/weather/connections/:id', () => {
  it('204 on own connection, 404 on second delete, 404 for another account', async () => {
    const created = await otherAgent.post('/api/weather/connections').send({
      provider: 'pws_tempest',
      credentials: { accessToken: 'tok-other' },
      stationId: 'station-other',
    });
    const id = created.body.id;

    const crossDelete = await supporterAgent.delete(`/api/weather/connections/${id}`);
    expect(crossDelete.status).toBe(404);

    const ownDelete = await otherAgent.delete(`/api/weather/connections/${id}`);
    expect(ownDelete.status).toBe(204);

    const secondDelete = await otherAgent.delete(`/api/weather/connections/${id}`);
    expect(secondDelete.status).toBe(404);
  });
});

// ── GET /current ──────────────────────────────────────────────────────────────

describe('GET /api/weather/current', () => {
  it('fetches from Tempest, stores a reading, and returns cached:false', async () => {
    vi.stubGlobal('fetch', routedFetchMock({ tempest: tempestFetchResponse() }));

    const created = await supporterAgent.post('/api/weather/connections').send({
      provider: 'pws_tempest',
      credentials: { accessToken: 'live-token' },
      stationId: 'live-station',
    });
    expect(created.status).toBe(201);

    const res = await supporterAgent.get('/api/weather/current');
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('pws_tempest');
    expect(res.body.cached).toBe(false);
    expect(res.body.temperature).toBe(18.5);

    const { rows } = await pool.query(
      'SELECT * FROM weather_readings WHERE connection_id = (SELECT id FROM weather_connections WHERE account_id = $1 AND is_primary = true)',
      [(await pool.query('SELECT id FROM accounts WHERE email = $1', ['weather-supporter@example.com'])).rows[0].id],
    );
    expect(rows.length).toBe(1);
  });

  it('returns cached:true on a second call within the TTL', async () => {
    const fetchMock = routedFetchMock({ tempest: tempestFetchResponse() });
    vi.stubGlobal('fetch', fetchMock);

    const res = await supporterAgent.get('/api/weather/current');
    expect(res.status).toBe(200);
    expect(res.body.cached).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches again once the cached reading has expired', async () => {
    const accountRes = await pool.query('SELECT id FROM accounts WHERE email = $1', ['weather-supporter@example.com']);
    const accountId = accountRes.rows[0].id;
    await pool.query(
      `UPDATE weather_readings SET created_at = now() - interval '11 minutes'
       WHERE connection_id = (SELECT id FROM weather_connections WHERE account_id = $1 AND is_primary = true)`,
      [accountId],
    );

    const fetchMock = routedFetchMock({ tempest: tempestFetchResponse({ air_temperature: 20.0 }) });
    vi.stubGlobal('fetch', fetchMock);

    const res = await supporterAgent.get('/api/weather/current');
    expect(res.status).toBe(200);
    expect(res.body.cached).toBe(false);
    expect(res.body.temperature).toBe(20.0);
    expect(fetchMock).toHaveBeenCalled();
  });

  it('falls back to public_weather when the account has no PWS connection', async () => {
    vi.stubGlobal('fetch', routedFetchMock({}));

    const res = await otherAgent.get('/api/weather/current');
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('public_weather');
    expect(res.body.temperature).toBe(22.1);
  });

  it('422 location_not_set when the account location is unset', async () => {
    vi.stubGlobal('fetch', routedFetchMock({}));
    const res = await noLocationAgent.get('/api/weather/current');
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('location_not_set');
  });

  it('503 when the upstream fetch fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }),
    );
    const res = await unreachableAgent.get('/api/weather/current');
    expect(res.status).toBe(503);
  });
});

// ── GET /history ──────────────────────────────────────────────────────────────

describe('GET /api/weather/history', () => {
  it('returns 7 days of Open-Meteo history', async () => {
    vi.stubGlobal('fetch', routedFetchMock({}));
    const res = await supporterAgent.get('/api/weather/history');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(7);
  });

  it('422 location_not_set when the account location is unset', async () => {
    vi.stubGlobal('fetch', routedFetchMock({}));
    const res = await noLocationAgent.get('/api/weather/history');
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('location_not_set');
  });
});

// ── POST /test-connection ─────────────────────────────────────────────────────

describe('POST /api/weather/test-connection', () => {
  it('ok:true on a successful live check, persists nothing', async () => {
    vi.stubGlobal('fetch', routedFetchMock({ tempest: tempestFetchResponse() }));
    const before = await pool.query('SELECT count(*)::int AS n FROM weather_connections');

    const res = await supporterAgent.post('/api/weather/test-connection').send({
      provider: 'pws_tempest',
      credentials: { accessToken: 'tok' },
      stationId: 'station-x',
    });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.reading).toBeDefined();

    const after = await pool.query('SELECT count(*)::int AS n FROM weather_connections');
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('ok:false when the upstream call fails, persists nothing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }),
    );
    const before = await pool.query('SELECT count(*)::int AS n FROM weather_connections');

    const res = await supporterAgent.post('/api/weather/test-connection').send({
      provider: 'pws_tempest',
      credentials: { accessToken: 'bad-tok' },
      stationId: 'station-y',
    });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.reason).toBe('auth_failed');

    const after = await pool.query('SELECT count(*)::int AS n FROM weather_connections');
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('400 for a non-tempest provider', async () => {
    const res = await supporterAgent.post('/api/weather/test-connection').send({
      provider: 'public_weather',
      credentials: {},
    });
    expect(res.status).toBe(400);
  });
});

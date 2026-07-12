import { Router, Request, Response } from 'express';
import { db } from '../lib/db';
import { requireAuth, requireSupporter } from '../middleware/auth';
import { encryptToBuffer, decryptFromBuffer } from '../lib/crypto';
import { LOCATION_NOT_SET } from '../lib/constants';
import { getTtlMs } from '../lib/weather/ttl';
import { fetchTempestCurrent } from '../lib/weather/providers/tempest';
import { geocode, fetchOpenMeteoCurrent, fetchOpenMeteoHistory } from '../lib/weather/providers/openMeteo';
import type { NormalizedReading } from '../lib/weather/types';

const weatherRouter = Router();
weatherRouter.use(requireAuth, requireSupporter);

const IMPLEMENTED_CONNECTION_PROVIDERS = new Set(['pws_tempest']);
const DIGITS_RE = /^\d+$/;

// ── Helpers ──────────────────────────────────────────────────────────────────

async function getAccountLocation(accountId: number): Promise<string | null> {
  const { rows } = await db.query<{ zone_location_label: string }>(
    'SELECT zone_location_label FROM accounts WHERE id = $1',
    [accountId],
  );
  const label = rows[0]?.zone_location_label;
  return label && label !== LOCATION_NOT_SET ? label : null;
}

function encryptCreds(obj: unknown): { enc: string } {
  return { enc: encryptToBuffer(JSON.stringify(obj)).toString('base64') };
}

function decryptCreds(jsonb: { enc: string }): Record<string, unknown> {
  return JSON.parse(decryptFromBuffer(Buffer.from(jsonb.enc, 'base64')));
}

interface WeatherReadingRow {
  reading_timestamp: string;
  temperature: string | null;
  humidity: string | null;
  wind_speed: string | null;
  wind_direction: string | null;
  precipitation_today: string | null;
  uv_index: string | null;
  pressure: string | null;
  created_at: string;
}

function formatReadingRow(row: WeatherReadingRow): NormalizedReading {
  return {
    readingTimestamp: row.reading_timestamp,
    temperature: row.temperature !== null ? Number(row.temperature) : null,
    humidity: row.humidity !== null ? Number(row.humidity) : null,
    windSpeed: row.wind_speed !== null ? Number(row.wind_speed) : null,
    windDirection: row.wind_direction,
    precipitationToday: row.precipitation_today !== null ? Number(row.precipitation_today) : null,
    uvIndex: row.uv_index !== null ? Number(row.uv_index) : null,
    pressure: row.pressure !== null ? Number(row.pressure) : null,
  };
}

// In-memory cache of public-weather current conditions, keyed by "lat,lon".
const publicCurrentCache = new Map<string, { reading: NormalizedReading; fetchedAt: number }>();

function tempestFailureReason(err: unknown): 'auth_failed' | 'not_found' | 'unreachable' {
  const message = err instanceof Error ? err.message : '';
  if (/status (401|403)/.test(message)) return 'auth_failed';
  if (/status 404/.test(message) || /no observations/i.test(message)) return 'not_found';
  return 'unreachable';
}

// ── POST /connections ─────────────────────────────────────────────────────────

weatherRouter.post('/connections', async (req: Request, res: Response): Promise<void> => {
  const accountId = req.session!.account!.id;
  const { provider, credentials, stationId, isPrimary } = req.body as Record<string, unknown>;

  if (provider === 'public_weather') {
    res.status(400).json({ error: 'public weather is the automatic fallback' });
    return;
  }
  if (typeof provider !== 'string' || !IMPLEMENTED_CONNECTION_PROVIDERS.has(provider)) {
    res.status(400).json({ error: 'Unsupported provider' });
    return;
  }

  const creds = (credentials ?? {}) as Record<string, unknown>;
  if (provider === 'pws_tempest') {
    if (typeof creds.accessToken !== 'string' || !creds.accessToken) {
      res.status(400).json({ error: 'credentials.accessToken is required' });
      return;
    }
    if (typeof stationId !== 'string' || !stationId) {
      res.status(400).json({ error: 'stationId is required' });
      return;
    }
  }

  const makePrimary = isPrimary !== false;

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    if (makePrimary) {
      await client.query('UPDATE weather_connections SET is_primary = false WHERE account_id = $1', [accountId]);
    }
    const { rows } = await client.query(
      `INSERT INTO weather_connections (account_id, provider, credentials, station_id, is_primary)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, provider, station_id, is_primary, last_successful_sync, created_at`,
      [accountId, provider, JSON.stringify(encryptCreds(creds)), stationId ?? null, makePrimary],
    );
    await client.query('COMMIT');

    const row = rows[0];
    res.status(201).json({
      id: row.id,
      provider: row.provider,
      stationId: row.station_id,
      isPrimary: row.is_primary,
      lastSuccessfulSync: row.last_successful_sync,
      createdAt: row.created_at,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ── GET /connections ──────────────────────────────────────────────────────────

weatherRouter.get('/connections', async (req: Request, res: Response): Promise<void> => {
  const accountId = req.session!.account!.id;
  try {
    const { rows } = await db.query(
      `SELECT id, provider, station_id, is_primary, last_successful_sync, created_at
         FROM weather_connections
        WHERE account_id = $1
        ORDER BY is_primary DESC, created_at ASC`,
      [accountId],
    );
    res.json({
      data: rows.map((row) => ({
        id: row.id,
        provider: row.provider,
        stationId: row.station_id,
        isPrimary: row.is_primary,
        lastSuccessfulSync: row.last_successful_sync,
        createdAt: row.created_at,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── DELETE /connections/:id ────────────────────────────────────────────────────

weatherRouter.delete('/connections/:id', async (req: Request, res: Response): Promise<void> => {
  const accountId = req.session!.account!.id;
  const id = req.params.id as string;

  if (!DIGITS_RE.test(id)) {
    res.status(404).json({ error: 'Connection not found' });
    return;
  }

  try {
    const { rowCount } = await db.query(
      'DELETE FROM weather_connections WHERE id = $1 AND account_id = $2 RETURNING id',
      [id, accountId],
    );
    if (rowCount === 0) {
      res.status(404).json({ error: 'Connection not found' });
      return;
    }
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /current ───────────────────────────────────────────────────────────────

weatherRouter.get('/current', async (req: Request, res: Response): Promise<void> => {
  const accountId = req.session!.account!.id;

  try {
    const { rows: connRows } = await db.query(
      `SELECT id, provider, credentials, station_id
         FROM weather_connections
        WHERE account_id = $1 AND is_primary = true`,
      [accountId],
    );
    const connection = connRows[0];

    if (connection && IMPLEMENTED_CONNECTION_PROVIDERS.has(connection.provider)) {
      const { rows: readingRows } = await db.query<WeatherReadingRow>(
        `SELECT reading_timestamp, temperature, humidity, wind_speed, wind_direction,
                precipitation_today, uv_index, pressure, created_at
           FROM weather_readings
          WHERE connection_id = $1
          ORDER BY reading_timestamp DESC
          LIMIT 1`,
        [connection.id],
      );
      const latest = readingRows[0];
      const ttlMs = getTtlMs(connection.provider);

      if (latest && Date.now() - new Date(latest.created_at).getTime() < ttlMs) {
        res.json({ ...formatReadingRow(latest), source: connection.provider, cached: true });
        return;
      }

      const creds = decryptCreds(connection.credentials);
      const reading = await fetchTempestCurrent(creds.accessToken as string, connection.station_id);

      await db.query(
        `INSERT INTO weather_readings
           (connection_id, reading_timestamp, temperature, humidity, wind_speed,
            wind_direction, precipitation_today, uv_index, pressure)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          connection.id,
          reading.readingTimestamp,
          reading.temperature,
          reading.humidity,
          reading.windSpeed,
          reading.windDirection,
          reading.precipitationToday,
          reading.uvIndex,
          reading.pressure,
        ],
      );
      await db.query('UPDATE weather_connections SET last_successful_sync = now() WHERE id = $1', [connection.id]);

      res.json({ ...reading, source: connection.provider, cached: false });
      return;
    }

    const location = await getAccountLocation(accountId);
    if (location === null) {
      res.status(422).json({ error: 'Location not set', code: 'location_not_set' });
      return;
    }

    const geo = await geocode(location);
    const cacheKey = `${geo.lat},${geo.lon}`;
    const ttlMs = getTtlMs('public_weather');
    const cached = publicCurrentCache.get(cacheKey);

    if (cached && Date.now() - cached.fetchedAt < ttlMs) {
      res.json({ ...cached.reading, source: 'public_weather', cached: true });
      return;
    }

    const reading = await fetchOpenMeteoCurrent(geo.lat, geo.lon);
    publicCurrentCache.set(cacheKey, { reading, fetchedAt: Date.now() });
    res.json({ ...reading, source: 'public_weather', cached: false });
  } catch (err) {
    console.error(err);
    res.status(503).json({ error: 'Weather data unavailable' });
  }
});

// ── GET /history ────────────────────────────────────────────────────────────────

weatherRouter.get('/history', async (req: Request, res: Response): Promise<void> => {
  const accountId = req.session!.account!.id;

  try {
    const location = await getAccountLocation(accountId);
    if (location === null) {
      res.status(422).json({ error: 'Location not set', code: 'location_not_set' });
      return;
    }

    const geo = await geocode(location);
    const data = await fetchOpenMeteoHistory(geo.lat, geo.lon);
    res.json({ data });
  } catch (err) {
    console.error(err);
    res.status(503).json({ error: 'Weather data unavailable' });
  }
});

// ── POST /test-connection ────────────────────────────────────────────────────────

weatherRouter.post('/test-connection', async (req: Request, res: Response): Promise<void> => {
  const { provider, credentials, stationId } = req.body as Record<string, unknown>;

  if (provider !== 'pws_tempest') {
    res.status(400).json({ error: 'Unsupported provider' });
    return;
  }

  const creds = (credentials ?? {}) as Record<string, unknown>;
  if (typeof creds.accessToken !== 'string' || !creds.accessToken || typeof stationId !== 'string' || !stationId) {
    res.status(400).json({ error: 'credentials.accessToken and stationId are required' });
    return;
  }

  try {
    const reading = await fetchTempestCurrent(creds.accessToken, stationId);
    res.json({ ok: true, reading });
  } catch (err) {
    res.json({ ok: false, reason: tempestFailureReason(err) });
  }
});

export default weatherRouter;

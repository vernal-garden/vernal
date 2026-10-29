import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { Pool, PoolClient } from 'pg';
import { Readable } from 'stream';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const { entries, appendOrder, appendOpts, archiverMode } = vi.hoisted(() => ({
  // The local-storage test needs a real ZIP; every other test uses the stand-in.
  archiverMode: { real: false },
  entries: new Map<string, string>(),
  appendOrder: [] as string[],
  appendOpts: new Map<string, Record<string, unknown>>(),
}));

vi.mock('./storage/s3', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./storage/s3')>()),
  uploadStreamToR2: vi.fn(),
  exportsBucket: vi.fn(() => 'test-exports'),
  getMediaObject: vi.fn(),
}));

// Stand-in for archiver's ZipArchive: records each entry's name and options in
// append order, reads it to the end, records its text by name, then emits
// 'entry' like the real one. finalize() ends the piped stream with a
// placeholder payload. With archiverMode.real, the real ZipArchive is used.
vi.mock('archiver', async (importOriginal) => {
  const real = await importOriginal<typeof import('archiver')>();
  const { EventEmitter } = await import('events');
  class FakeZipArchive extends EventEmitter {
    private dest: NodeJS.WritableStream | null = null;
    pipe<T extends NodeJS.WritableStream>(dest: T): T {
      this.dest = dest;
      return dest;
    }
    append(source: string | Buffer | Readable, opts: { name: string } & Record<string, unknown>) {
      appendOrder.push(opts.name);
      appendOpts.set(opts.name, opts);
      void (async () => {
        let text = '';
        if (typeof source === 'string' || Buffer.isBuffer(source)) text = source.toString();
        else for await (const chunk of source) text += (chunk as Buffer | string).toString();
        entries.set(opts.name, text);
        this.emit('entry', { name: opts.name });
      })().catch(() => undefined); // a failing source reports through its own 'error' event
      return this;
    }
    abort() {
      return this;
    }
    async finalize() {
      this.dest?.end(Buffer.from('fake-zip'));
    }
  }
  class ZipArchive {
    constructor(opts?: ConstructorParameters<typeof real.ZipArchive>[0]) {
      return (archiverMode.real ? new real.ZipArchive(opts) : new FakeZipArchive()) as unknown as ZipArchive;
    }
  }
  return { ZipArchive };
});

import { uploadStreamToR2, exportsBucket, getMediaObject } from './storage/s3';
import { jobDb } from './db';
import { processExportJob } from './exportWorker';
import { getServerConfig, setServerConfigForTests } from './serverConfig';

const uploadMock = vi.mocked(uploadStreamToR2);
const exportsBucketMock = vi.mocked(exportsBucket);
const getObjectMock = vi.mocked(getMediaObject);

const photoBytes = (key: string) => `bytes:${key}`;

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL must be set to run tests');

const pool = new Pool({ connectionString: url });

const EXPECTED_FILES = [
  'account.json',
  'gardens.json',
  'plantings.json',
  'personal_seeds.json',
  'seed_photos.json',
  'harvest_entries.json',
  'sowing_events.json',
  'seed_preferences.json',
  'soil_readings.json',
  'amendment_logs.json',
  'weather_connections.json',
  'feedback.json',
  'usage_events.json',
  'oauth_identities.json',
  'notifications.json',
  'contributions.json',
  'seed_ratings.json',
  'weather_readings.json',
];

type Row = Record<string, unknown>;

let accountId: number;
let otherAccountId: number;
let cambiumSeedId: number;
let mine: AccountFixture;
let other: AccountFixture;

async function insert(sql: string, params: unknown[]): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(`${sql} RETURNING id`, params);
  return rows[0].id;
}

async function createAccount(email: string): Promise<number> {
  return insert(
    `INSERT INTO accounts
       (email, password_hash, zone, zone_location_label, stripe_customer_id, stripe_subscription_id)
     VALUES ($1, 'secret-hash', '7b', 'Test City', $2, $3)`,
    [email, `cus_${email}`, `sub_${email}`],
  );
}

async function seedAccountData(ownerId: number, label: string) {
  const gardenId = await insert(
    `INSERT INTO gardens (owner_id, name, style, zone) VALUES ($1, $2, 'grid', '7b')`,
    [ownerId, `${label} Garden`],
  );
  const bedId = await insert(
    `INSERT INTO beds (garden_id, season, type, label, grid_x, grid_y, grid_cols, grid_rows)
     VALUES ($1, 2026, 'grid', $2, 0, 0, 4, 4)`,
    [gardenId, `${label} Bed`],
  );
  const seedId = await insert(
    `INSERT INTO seeds (owner_id, common_name, origin) VALUES ($1, $2, 'user_created')`,
    [ownerId, `${label} Tomato`],
  );
  const seedPhotoKey = `seed-photos/${seedId}/${randomUUID()}.jpg`;
  await insert(
    `INSERT INTO seed_photos (seed_id, storage_url, r2_key, taken_at) VALUES ($1, $2, $2, '2026-05-01')`,
    [seedId, seedPhotoKey],
  );
  const plantingId = await insert(
    `INSERT INTO plantings (bed_id, garden_id, season, cambium_seed_id, cell_x, cell_y, planting_date)
     VALUES ($1, $2, 2026, $3, 0, 0, '2026-04-15')`,
    [bedId, gardenId, cambiumSeedId],
  );
  const sowingId = await insert(
    `INSERT INTO sowing_events (planting_id, garden_id, seed_id, season) VALUES ($1, $2, $3, 2026)`,
    [plantingId, gardenId, seedId],
  );
  const harvestId = await insert(
    `INSERT INTO harvest_entries (sowing_event_id, garden_id, seed_id, quantity, unit)
     VALUES ($1, $2, $3, 1.5, 'kg')`,
    [sowingId, gardenId, seedId],
  );
  // The key names the entry, so the photo is added once the entry exists.
  const harvestPhotoKey = `harvest-photos/${harvestId}/${randomUUID()}.jpg`;
  await pool.query('UPDATE harvest_entries SET photos = $2 WHERE id = $1', [
    harvestId,
    JSON.stringify([{ key: harvestPhotoKey, url: `https://old.r2.dev/${harvestPhotoKey}` }]),
  ]);
  await insert(
    `INSERT INTO soil_readings (user_id, garden_id, bed_id, test_date, ph)
     VALUES ($1, $2, $3, '2026-03-01', 6.5)`,
    [ownerId, gardenId, bedId],
  );
  const amendmentId = await insert(
    `INSERT INTO amendment_logs (user_id, garden_id, application_date, product_name, amendment_type)
     VALUES ($1, $2, '2026-03-10', 'Compost', 'compost_manure')`,
    [ownerId, gardenId],
  );
  await pool.query(
    'INSERT INTO amendment_log_beds (amendment_log_id, bed_id) VALUES ($1, $2)',
    [amendmentId, bedId],
  );
  const connectionId = await insert(
    `INSERT INTO weather_connections (account_id, provider, credentials, station_id)
     VALUES ($1, 'pws_tempest', $2, 'ST-1')`,
    [ownerId, JSON.stringify({ apiKey: `${label}-weather-secret` })],
  );
  await insert(
    `INSERT INTO user_seed_preferences (account_id, seed_id, garden_id, custom_direct_sow_date)
     VALUES ($1, $2, $3, '2026-04-01')`,
    [ownerId, seedId, gardenId],
  );
  await insert(
    `INSERT INTO feedback_submissions (user_id, category, message) VALUES ($1, 'general', $2)`,
    [ownerId, `${label} feedback`],
  );
  await insert(
    `INSERT INTO micro_feedback_responses (account_id, trigger_key, response) VALUES ($1, 'planted', 'yes')`,
    [ownerId],
  );
  await insert(
    `INSERT INTO usage_events (user_id, session_id, event_key) VALUES ($1, 'sess', 'garden_opened')`,
    [ownerId],
  );
  await insert(
    `INSERT INTO oauth_identities (account_id, provider, provider_user_id, provider_email, access_token_encrypted)
     VALUES ($1, 'google', $2, $3, $4)`,
    [ownerId, `${label}-google-id`, `${label}@gmail.example.com`, Buffer.from(`${label}-oauth-token`)],
  );
  await insert(
    `INSERT INTO notifications (account_id, type, payload) VALUES ($1, 'contribution_approved', $2)`,
    [ownerId, JSON.stringify({ note: `${label} notification` })],
  );
  await insert(
    `INSERT INTO moderation_items (type, cambium_seed_id, submitted_by, content, resolution_note)
     VALUES ('correction', $1, $2, $3, $4)`,
    [cambiumSeedId, ownerId, JSON.stringify({ field: `${label} correction` }), `${label} moderator note`],
  );
  await insert(
    `INSERT INTO cambium.seed_ratings (seed_id, account_id, rating) VALUES ($1, $2, $3)`,
    [cambiumSeedId, ownerId, label === 'Mine' ? 4 : 2],
  );
  // More readings than one cursor batch (500) for the test account.
  await pool.query(
    `INSERT INTO weather_readings (connection_id, reading_timestamp, temperature, wind_direction)
     SELECT $1, '2026-06-01T00:00:00Z'::timestamptz + make_interval(mins => n), 20.5, $2
     FROM generate_series(1, $3::int) AS n`,
    [connectionId, `${label}-wind`, label === 'Mine' ? 1201 : 1],
  );
  await pool.query(
    `UPDATE gardens SET thumbnail_url = $2 WHERE id = $1`,
    [gardenId, `garden-thumbnails/${gardenId}/${randomUUID()}.png`],
  );
  return { gardenId, bedId, seedId, connectionId, harvestId, seedPhotoKey, harvestPhotoKey };
}

type AccountFixture = Awaited<ReturnType<typeof seedAccountData>>;

const seedPhotoPath = (f: AccountFixture) =>
  `photos/seeds/${f.seedId}/${f.seedPhotoKey.slice(f.seedPhotoKey.lastIndexOf('/') + 1)}`;
const harvestPhotoPath = (f: AccountFixture) =>
  `photos/harvests/${f.harvestId}/${f.harvestPhotoKey.slice(f.harvestPhotoKey.lastIndexOf('/') + 1)}`;

async function createJob(): Promise<number> {
  return insert(`INSERT INTO data_export_jobs (account_id) VALUES ($1)`, [accountId]);
}

function json(name: string): unknown {
  const text = entries.get(name);
  if (text === undefined) throw new Error(`${name} was not exported`);
  return JSON.parse(text);
}

// Runs a full export for the test account and leaves its files in `entries`.
async function runExport(): Promise<number> {
  const jobId = await createJob();
  await processExportJob(jobId);
  return jobId;
}

beforeAll(async () => {
  await pool.query(
    `TRUNCATE accounts, guest_sessions, gardens, seeds, data_export_jobs,
              feedback_submissions, usage_events RESTART IDENTITY CASCADE`,
  );
  cambiumSeedId = await insert(
    `INSERT INTO cambium.seeds (common_name, source) VALUES ('Export Test Basil', 'editorial')`,
    [],
  );
  accountId = await createAccount('export-owner@example.com');
  otherAccountId = await createAccount('export-other@example.com');
  mine = await seedAccountData(accountId, 'Mine');
  other = await seedAccountData(otherAccountId, 'Other');
});

afterAll(async () => {
  await pool.query('DELETE FROM cambium.seeds WHERE id = $1', [cambiumSeedId]);
  await pool.end();
});

beforeEach(() => {
  entries.clear();
  appendOrder.length = 0;
  appendOpts.clear();
  getObjectMock
    .mockReset()
    .mockImplementation(async (key: string) => Readable.from([Buffer.from(photoBytes(key))]));
  // Consume the archive stream so the upload "finishes", as lib-storage would.
  uploadMock.mockReset().mockImplementation(async (_key, body) => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _chunk of body) {
      // drain
    }
  });
  exportsBucketMock.mockReset().mockReturnValue('test-exports');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('export contents', () => {
  it('writes every export file with the account data', async () => {
    await runExport();
    expect([...entries.keys()].sort()).toEqual(
      [...EXPECTED_FILES, 'README.txt', seedPhotoPath(mine), harvestPhotoPath(mine)].sort(),
    );

    const gardens = json('gardens.json') as Row[];
    expect(gardens).toHaveLength(1);
    expect(gardens[0].name).toBe('Mine Garden');
    expect((gardens[0].beds as Row[])[0].label).toBe('Mine Bed');

    const plantings = json('plantings.json') as Row[];
    expect(plantings).toHaveLength(1);
    expect(plantings[0].commonName).toBe('Export Test Basil');
    expect(plantings[0].plantingDate).toBe('2026-04-15');

    const harvests = json('harvest_entries.json') as Row[];
    expect(harvests).toHaveLength(1);
    expect(harvests[0]).toMatchObject({
      commonName: 'Mine Tomato',
      gardenName: 'Mine Garden',
      quantity: 1.5,
      photos: [{ file: harvestPhotoPath(mine) }],
    });
    expect(typeof harvests[0].harvestedAt).toBe('string');
    expect(new Date(harvests[0].harvestedAt as string).toISOString()).toBe(harvests[0].harvestedAt);

    const sowing = json('sowing_events.json') as Row[];
    expect(sowing).toHaveLength(1);
    expect(sowing[0].commonName).toBe('Mine Tomato');

    expect(json('soil_readings.json')).toHaveLength(1);
    expect((json('amendment_logs.json') as Row[])[0].bedIds).toHaveLength(1);
    expect(json('weather_connections.json')).toHaveLength(1);

    const feedback = json('feedback.json') as { submissions: Row[]; microFeedback: Row[] };
    expect(feedback.submissions).toHaveLength(1);
    expect(feedback.microFeedback).toHaveLength(1);
    expect(json('usage_events.json')).toEqual([
      { eventKey: 'garden_opened', createdAt: expect.any(String) },
    ]);
  });

  it('pretty-prints streamed files like JSON.stringify(rows, null, 2)', async () => {
    await runExport();
    for (const name of ['plantings.json', 'usage_events.json']) {
      const text = entries.get(name)!;
      expect(text).toBe(JSON.stringify(JSON.parse(text), null, 2));
    }
  });

  it('never exports password hashes, Stripe ids or weather credentials', async () => {
    await pool.query(
      `UPDATE accounts SET terms_version = '2026-10-26', terms_accepted_at = NOW() WHERE id = $1`,
      [accountId],
    );
    await runExport();
    const account = json('account.json') as Row;
    expect(account.email).toBe('export-owner@example.com');
    expect(account).not.toHaveProperty('passwordHash');
    expect(account).not.toHaveProperty('stripeCustomerId');
    expect(account).not.toHaveProperty('stripeSubscriptionId');
    expect(typeof account.createdAt).toBe('string');
    expect(account.termsVersion).toBe('2026-10-26');
    expect(typeof account.termsAcceptedAt).toBe('string');

    for (const conn of json('weather_connections.json') as Row[]) {
      expect(conn).not.toHaveProperty('credentials');
    }

    const serialized = [...entries.values()].join('\n');
    expect(serialized).not.toContain('secret-hash');
    expect(serialized).not.toContain('cus_');
    expect(serialized).not.toContain('weather-secret');
  });

  it("never includes another account's gardens, harvests or seeds", async () => {
    await runExport();
    const serialized = [...entries.values()].join('\n');
    expect(serialized).not.toContain('Other Garden');
    expect(serialized).not.toContain('Other Tomato');
    expect(serialized).not.toContain('Other feedback');
    expect(serialized).not.toContain('export-other@example.com');

    for (const h of json('harvest_entries.json') as Row[]) {
      expect(h.gardenName).toBe('Mine Garden');
    }
    for (const s of json('personal_seeds.json') as Row[]) {
      expect(s.ownerId).toBe(accountId);
    }
  });
});

describe('export contents: sign-ins, notifications, contributions, ratings, weather', () => {
  it('exports sign-in identities without tokens', async () => {
    await runExport();
    expect(json('oauth_identities.json')).toEqual([
      {
        provider: 'google',
        providerUserId: 'Mine-google-id',
        providerEmail: 'Mine@gmail.example.com',
        createdAt: expect.any(String),
      },
    ]);
  });

  it('exports notifications', async () => {
    await runExport();
    expect(json('notifications.json')).toEqual([
      {
        id: expect.any(Number),
        type: 'contribution_approved',
        payload: { note: 'Mine notification' },
        readAt: null,
        createdAt: expect.any(String),
      },
    ]);
  });

  it('exports contributions without the moderator note', async () => {
    await runExport();
    const contributions = json('contributions.json') as Row[];
    expect(contributions).toEqual([
      {
        id: expect.any(Number),
        type: 'correction',
        seedId: null,
        cambiumSeedId,
        content: { field: 'Mine correction' },
        status: 'new',
        createdAt: expect.any(String),
        resolvedAt: null,
      },
    ]);
    expect(entries.get('contributions.json')).not.toContain('moderator note');
  });

  it('exports seed ratings with the seed name', async () => {
    await runExport();
    expect(json('seed_ratings.json')).toEqual([
      { seedId: cambiumSeedId, commonName: 'Export Test Basil', rating: 4, createdAt: expect.any(String) },
    ]);
  });

  it('exports every weather reading across cursor batches, in time order', async () => {
    await runExport();
    const readings = json('weather_readings.json') as Row[];
    expect(readings).toHaveLength(1201);
    expect(readings[0]).toEqual({
      connectionId: expect.any(Number),
      provider: 'pws_tempest',
      readingTimestamp: '2026-06-01T00:01:00.000Z',
      temperature: 20.5,
      humidity: null,
      windSpeed: null,
      windDirection: 'Mine-wind',
      precipitationToday: null,
      uvIndex: null,
      pressure: null,
    });
    const times = readings.map((r) => r.readingTimestamp as string);
    expect([...times].sort()).toEqual(times);
  });

  it("never includes another account's rows in the new files", async () => {
    await runExport();
    const serialized = [...entries.values()].join('\n');
    expect(serialized).not.toContain('Other-google-id');
    expect(serialized).not.toContain('Other notification');
    expect(serialized).not.toContain('Other correction');
    expect(serialized).not.toContain('Other-wind');
    expect(serialized).not.toContain('oauth-token');
    expect((json('seed_ratings.json') as Row[]).map((r) => r.rating)).toEqual([4]);
  });

  it('lists every file in the README', async () => {
    await runExport();
    const readmeText = entries.get('README.txt')!;
    expect(readmeText).not.toContain('Photos are listed by URL.');
    expect(readmeText).toContain('Photos are in the photos folder');
    for (const name of [...EXPECTED_FILES, 'photos/']) expect(readmeText).toContain(name);
  });
});

describe('export contents: photo files', () => {
  it('includes each photo file and names it in the JSON', async () => {
    await runExport();
    expect(entries.get(seedPhotoPath(mine))).toBe(photoBytes(mine.seedPhotoKey));
    expect(entries.get(harvestPhotoPath(mine))).toBe(photoBytes(mine.harvestPhotoKey));
    expect(appendOpts.get(seedPhotoPath(mine))).toMatchObject({ store: true });
    expect(appendOpts.get(harvestPhotoPath(mine))).toMatchObject({ store: true });

    const seedPhotos = json('seed_photos.json') as Row[];
    expect(seedPhotos).toHaveLength(1);
    expect(seedPhotos[0].file).toBe(seedPhotoPath(mine));
    expect(seedPhotos[0]).not.toHaveProperty('storageUrl');
    expect(seedPhotos[0]).not.toHaveProperty('r2Key');

    const harvests = json('harvest_entries.json') as Row[];
    expect(harvests[0].photos).toEqual([{ file: harvestPhotoPath(mine) }]);
    expect(entries.get('harvest_entries.json')).not.toContain('r2.dev');
  });

  it('appends photo files before any JSON file', async () => {
    await runExport();
    const firstJson = appendOrder.indexOf('account.json');
    expect(firstJson).toBeGreaterThan(-1);
    expect(appendOrder.indexOf(seedPhotoPath(mine))).toBeGreaterThan(-1);
    expect(appendOrder.indexOf(seedPhotoPath(mine))).toBeLessThan(firstJson);
    expect(appendOrder.indexOf(harvestPhotoPath(mine))).toBeGreaterThan(-1);
    expect(appendOrder.indexOf(harvestPhotoPath(mine))).toBeLessThan(firstJson);
    expect(appendOrder.slice(0, firstJson).every((name) => name.startsWith('photos/'))).toBe(true);
  });

  it('skips a missing photo, marks its file null and still completes', async () => {
    getObjectMock.mockImplementation(async (key: string) =>
      key === mine.seedPhotoKey ? null : Readable.from([Buffer.from(photoBytes(key))]),
    );
    const jobId = await runExport();

    expect(entries.has(seedPhotoPath(mine))).toBe(false);
    expect(entries.get(harvestPhotoPath(mine))).toBe(photoBytes(mine.harvestPhotoKey));
    expect((json('seed_photos.json') as Row[])[0].file).toBeNull();
    expect((json('harvest_entries.json') as Row[])[0].photos).toEqual([
      { file: harvestPhotoPath(mine) },
    ]);

    const { rows } = await pool.query('SELECT status FROM data_export_jobs WHERE id = $1', [jobId]);
    expect(rows[0]).toEqual({ status: 'complete' });
  });

  it('marks the job failed when a photo cannot be read', async () => {
    getObjectMock.mockRejectedValue(Object.assign(new Error('R2 unavailable'), { name: 'InternalError' }));
    const jobId = await runExport();

    const { rows } = await pool.query('SELECT status FROM data_export_jobs WHERE id = $1', [jobId]);
    expect(rows[0]).toEqual({ status: 'failed' });
    expect(entries.has('account.json')).toBe(false);
  });

  it('drops the thumbnail reference from gardens.json', async () => {
    await runExport();
    for (const g of json('gardens.json') as Row[]) {
      expect(g).not.toHaveProperty('thumbnailUrl');
    }
    expect(entries.get('gardens.json')).not.toContain('garden-thumbnails/');
  });

  it("never fetches another account's photos", async () => {
    await runExport();
    const fetched = getObjectMock.mock.calls.map(([key]) => key).sort();
    expect(fetched).toEqual([mine.seedPhotoKey, mine.harvestPhotoKey].sort());
    expect(fetched).not.toContain(other.seedPhotoKey);
    expect(fetched).not.toContain(other.harvestPhotoKey);
    const serialized = [...entries.values()].join('\n');
    expect(serialized).not.toContain(other.seedPhotoKey);
    expect(serialized).not.toContain(other.harvestPhotoKey);
  });
});

describe('processExportJob', () => {
  it('uploads the archive stream and marks the job complete without storing a URL', async () => {
    const jobId = await runExport();

    expect(uploadMock).toHaveBeenCalledWith(
      `exports/${accountId}/${jobId}.zip`,
      expect.objectContaining({ pipe: expect.any(Function) }),
      'application/zip',
      'test-exports',
    );

    const { rows } = await pool.query(
      `SELECT status, completed_at,
              expires_at BETWEEN now() + interval '6 days 23 hours' AND now() + interval '7 days 1 hour'
                AS expires_in_week
       FROM data_export_jobs WHERE id = $1`,
      [jobId],
    );
    expect(rows[0].status).toBe('complete');
    expect(rows[0].completed_at).not.toBeNull();
    expect(rows[0].expires_in_week).toBe(true);
  });

  it('reads everything on one client in one read-only snapshot', async () => {
    const queries: string[] = [];
    const realConnect = jobDb.connect.bind(jobDb) as () => Promise<PoolClient>;
    // Pool.query also calls connect (with a callback); only count direct checkouts.
    const connectSpy = vi.spyOn(jobDb, 'connect').mockImplementation(((...args: unknown[]) => {
      if (args.length > 0) return (realConnect as (...a: unknown[]) => unknown)(...args);
      return realConnect().then((client) => {
        const realQuery = client.query.bind(client) as (...a: unknown[]) => unknown;
        const realRelease = client.release.bind(client);
        // Record only while the worker holds the client: once released, the
        // pool hands the same client to later db.query calls.
        let checkedOut = true;
        vi.spyOn(client, 'query').mockImplementation(((...a: unknown[]) => {
          const first = a[0];
          if (checkedOut) {
            queries.push(typeof first === 'string' ? first : (first as { text?: string }).text ?? 'cursor');
          }
          return realQuery(...a);
        }) as never);
        vi.spyOn(client, 'release').mockImplementation(((err?: Error | boolean) => {
          checkedOut = false;
          return realRelease(err);
        }) as never);
        return client;
      });
    }) as never);

    await runExport();

    const checkouts = connectSpy.mock.calls.filter((c) => (c as unknown[]).length === 0);
    expect(checkouts).toHaveLength(1);
    expect(queries[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(queries[queries.length - 1]).toBe('COMMIT');
  });

  it('marks the job failed and resolves when the upload throws', async () => {
    uploadMock.mockReset().mockRejectedValueOnce(new Error('R2 unavailable'));
    const jobId = await createJob();

    await expect(processExportJob(jobId)).resolves.toBeUndefined();

    const { rows } = await pool.query(
      'SELECT status FROM data_export_jobs WHERE id = $1',
      [jobId],
    );
    expect(rows[0]).toEqual({ status: 'failed' });
    // The failed job's connection went back (or was discarded): the pool still serves a full export.
    entries.clear();
    uploadMock.mockReset().mockImplementation(async (_key, body) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _chunk of body) {
        // drain
      }
    });
    await runExport();
    expect(entries.has('README.txt')).toBe(true);
    expect(jobDb.waitingCount).toBe(0);
  });

  it('marks the job failed without uploading when the exports bucket is not configured', async () => {
    exportsBucketMock.mockImplementation(() => {
      throw new Error('R2_EXPORTS_BUCKET_NAME is not set.');
    });
    const jobId = await createJob();

    await expect(processExportJob(jobId)).resolves.toBeUndefined();

    expect(uploadMock).not.toHaveBeenCalled();
    const { rows } = await pool.query(
      'SELECT status FROM data_export_jobs WHERE id = $1',
      [jobId],
    );
    expect(rows[0]).toEqual({ status: 'failed' });
  });
});

describe('processExportJob with local storage', () => {
  const s3Config = getServerConfig();
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vernal-export-'));
    vi.stubEnv('MEDIA_DIR', dir);
    setServerConfigForTests({ ...s3Config, media: 'local' });
    archiverMode.real = true;
    for (const key of [mine.seedPhotoKey, mine.harvestPhotoKey]) {
      const file = path.join(dir, 'media', ...key.split('/'));
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, photoBytes(key));
    }
  });

  afterEach(async () => {
    archiverMode.real = false;
    setServerConfigForTests(s3Config);
    vi.unstubAllEnvs();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('writes a ZIP under MEDIA_DIR/exports that contains the photo files', async () => {
    const jobId = await runExport();

    const { rows } = await pool.query('SELECT status FROM data_export_jobs WHERE id = $1', [jobId]);
    expect(rows[0]).toEqual({ status: 'complete' });
    expect(uploadMock).not.toHaveBeenCalled();
    expect(getObjectMock).not.toHaveBeenCalled();

    const zipDir = path.join(dir, 'exports', 'exports', String(accountId));
    expect(await fs.readdir(zipDir)).toEqual([`${jobId}.zip`]);
    const zip = await fs.readFile(path.join(zipDir, `${jobId}.zip`));
    expect(zip.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    // Photos are stored uncompressed, so each one's name and bytes appear as is.
    for (const [name, key] of [
      [seedPhotoPath(mine), mine.seedPhotoKey],
      [harvestPhotoPath(mine), mine.harvestPhotoKey],
    ]) {
      expect(zip.includes(Buffer.from(name)), name).toBe(true);
      expect(zip.includes(Buffer.from(photoBytes(key))), key).toBe(true);
    }
    expect(zip.includes(Buffer.from('README.txt'))).toBe(true);
  });
});

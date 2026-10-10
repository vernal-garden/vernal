import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { Pool } from 'pg';

const { appendedNames } = vi.hoisted(() => ({ appendedNames: [] as string[] }));

vi.mock('./r2', () => ({
  uploadToR2: vi.fn(),
  getPresignedDownloadUrl: vi.fn(),
  deleteFromR2: vi.fn(),
  exportsBucket: vi.fn(() => 'test-exports'),
}));

// Minimal stand-in for archiver's ZipArchive: records entry names and writes a
// placeholder payload to the piped stream on finalize.
vi.mock('archiver', () => {
  class ZipArchive {
    private dest: NodeJS.WritableStream | null = null;
    on() {
      return this;
    }
    pipe<T extends NodeJS.WritableStream>(dest: T): T {
      this.dest = dest;
      return dest;
    }
    append(_data: string, opts: { name: string }) {
      appendedNames.push(opts.name);
      return this;
    }
    async finalize() {
      this.dest?.end(Buffer.from('fake-zip'));
    }
  }
  return { ZipArchive };
});

import { uploadToR2, getPresignedDownloadUrl, exportsBucket } from './r2';
import { collectExportData, processExportJob } from './exportWorker';

const uploadMock = vi.mocked(uploadToR2);
const presignMock = vi.mocked(getPresignedDownloadUrl);
const exportsBucketMock = vi.mocked(exportsBucket);

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
];

type Row = Record<string, unknown>;

let accountId: number;
let otherAccountId: number;
let cambiumSeedId: number;

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
  await insert(
    `INSERT INTO seed_photos (seed_id, storage_url, taken_at) VALUES ($1, $2, '2026-05-01')`,
    [seedId, `https://cdn.example.com/${label}.jpg`],
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
  await insert(
    `INSERT INTO harvest_entries (sowing_event_id, garden_id, seed_id, quantity, unit, photos)
     VALUES ($1, $2, $3, 1.5, 'kg', $4)`,
    [sowingId, gardenId, seedId, JSON.stringify([`https://cdn.example.com/${label}-harvest.jpg`])],
  );
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
  await insert(
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
  return { gardenId, bedId, seedId };
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
  await seedAccountData(accountId, 'Mine');
  await seedAccountData(otherAccountId, 'Other');
});

afterAll(async () => {
  await pool.query('DELETE FROM cambium.seeds WHERE id = $1', [cambiumSeedId]);
  await pool.end();
});

describe('collectExportData', () => {
  it('returns every export file with the account data', async () => {
    const data = await collectExportData(accountId);
    expect(Object.keys(data).sort()).toEqual([...EXPECTED_FILES].sort());

    const gardens = data['gardens.json'] as Row[];
    expect(gardens).toHaveLength(1);
    expect(gardens[0].name).toBe('Mine Garden');
    expect((gardens[0].beds as Row[])[0].label).toBe('Mine Bed');

    const plantings = data['plantings.json'] as Row[];
    expect(plantings).toHaveLength(1);
    expect(plantings[0].commonName).toBe('Export Test Basil');
    expect(plantings[0].plantingDate).toBe('2026-04-15');

    const harvests = data['harvest_entries.json'] as Row[];
    expect(harvests).toHaveLength(1);
    expect(harvests[0]).toMatchObject({
      commonName: 'Mine Tomato',
      gardenName: 'Mine Garden',
      quantity: 1.5,
      photos: ['https://cdn.example.com/Mine-harvest.jpg'],
    });
    expect(typeof harvests[0].harvestedAt).toBe('string');
    expect(new Date(harvests[0].harvestedAt as string).toISOString()).toBe(harvests[0].harvestedAt);

    const sowing = data['sowing_events.json'] as Row[];
    expect(sowing).toHaveLength(1);
    expect(sowing[0].commonName).toBe('Mine Tomato');

    expect(data['soil_readings.json']).toHaveLength(1);
    expect((data['seed_photos.json'] as Row[])[0].storageUrl).toBe('https://cdn.example.com/Mine.jpg');
    expect((data['amendment_logs.json'] as Row[])[0].bedIds).toHaveLength(1);
    expect(data['weather_connections.json']).toHaveLength(1);

    const feedback = data['feedback.json'] as { submissions: Row[]; microFeedback: Row[] };
    expect(feedback.submissions).toHaveLength(1);
    expect(feedback.microFeedback).toHaveLength(1);
    expect(data['usage_events.json']).toEqual([
      { eventKey: 'garden_opened', createdAt: expect.any(String) },
    ]);
  });

  it('never exports password hashes, Stripe ids or weather credentials', async () => {
    const data = await collectExportData(accountId);
    const account = data['account.json'] as Row;
    expect(account.email).toBe('export-owner@example.com');
    expect(account).not.toHaveProperty('passwordHash');
    expect(account).not.toHaveProperty('stripeCustomerId');
    expect(account).not.toHaveProperty('stripeSubscriptionId');
    expect(typeof account.createdAt).toBe('string');

    for (const conn of data['weather_connections.json'] as Row[]) {
      expect(conn).not.toHaveProperty('credentials');
    }

    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain('secret-hash');
    expect(serialized).not.toContain('cus_');
    expect(serialized).not.toContain('weather-secret');
  });

  it("never includes another account's gardens, harvests or seeds", async () => {
    const data = await collectExportData(accountId);
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain('Other Garden');
    expect(serialized).not.toContain('Other Tomato');
    expect(serialized).not.toContain('Other feedback');
    expect(serialized).not.toContain('export-other@example.com');

    for (const h of data['harvest_entries.json'] as Row[]) {
      expect(h.gardenName).toBe('Mine Garden');
    }
    for (const s of data['personal_seeds.json'] as Row[]) {
      expect(s.ownerId).toBe(accountId);
    }
  });
});

describe('processExportJob', () => {
  async function createJob(): Promise<number> {
    return insert(`INSERT INTO data_export_jobs (account_id) VALUES ($1)`, [accountId]);
  }

  beforeEach(() => {
    appendedNames.length = 0;
    uploadMock.mockReset().mockResolvedValue('https://cdn.example.com/export.zip');
    presignMock.mockReset().mockResolvedValue('https://signed.example.com/export.zip');
    exportsBucketMock.mockReset().mockReturnValue('test-exports');
  });

  it('builds the ZIP, uploads it and marks the job complete', async () => {
    const jobId = await createJob();
    await processExportJob(jobId);

    expect(appendedNames.sort()).toEqual([...EXPECTED_FILES, 'README.txt'].sort());
    expect(uploadMock).toHaveBeenCalledWith(
      `exports/${accountId}/${jobId}.zip`,
      expect.any(Buffer),
      'application/zip',
      'test-exports',
    );
    expect(presignMock).toHaveBeenCalledWith(
      `exports/${accountId}/${jobId}.zip`,
      604800,
      'test-exports',
    );

    const { rows } = await pool.query(
      `SELECT status, download_url, completed_at,
              expires_at BETWEEN now() + interval '6 days 23 hours' AND now() + interval '7 days 1 hour'
                AS expires_in_week
       FROM data_export_jobs WHERE id = $1`,
      [jobId],
    );
    expect(rows[0].status).toBe('complete');
    expect(rows[0].download_url).toBe('https://signed.example.com/export.zip');
    expect(rows[0].completed_at).not.toBeNull();
    expect(rows[0].expires_in_week).toBe(true);
  });

  it('marks the job failed and resolves when the upload throws', async () => {
    uploadMock.mockRejectedValueOnce(new Error('R2 unavailable'));
    const jobId = await createJob();

    await expect(processExportJob(jobId)).resolves.toBeUndefined();

    const { rows } = await pool.query(
      'SELECT status, download_url FROM data_export_jobs WHERE id = $1',
      [jobId],
    );
    expect(rows[0]).toEqual({ status: 'failed', download_url: null });
  });

  it('marks the job failed without uploading when the exports bucket is not configured', async () => {
    exportsBucketMock.mockImplementation(() => {
      throw new Error('R2_EXPORTS_BUCKET_NAME is not set.');
    });
    const jobId = await createJob();

    await expect(processExportJob(jobId)).resolves.toBeUndefined();

    expect(uploadMock).not.toHaveBeenCalled();
    const { rows } = await pool.query(
      'SELECT status, download_url FROM data_export_jobs WHERE id = $1',
      [jobId],
    );
    expect(rows[0]).toEqual({ status: 'failed', download_url: null });
  });
});

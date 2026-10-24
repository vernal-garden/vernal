import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { Pool } from 'pg';
import sharp from 'sharp';

vi.mock('../lib/r2', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/r2')>()),
  uploadToR2: vi.fn(),
  deleteFromR2: vi.fn(),
}));

vi.mock('../lib/r2Cleanup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/r2Cleanup')>()),
  drainSoon: vi.fn(),
}));

// The real processor, wrapped so a test can force a busy limiter.
vi.mock('../lib/imageProcessing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/imageProcessing')>();
  return { ...actual, processPhoto: vi.fn(actual.processPhoto) };
});

import { uploadToR2, deleteFromR2 } from '../lib/r2';
import { drainSoon } from '../lib/r2Cleanup';
import { ImageBusyError, processPhoto } from '../lib/imageProcessing';
import app from '../index';

const uploadToR2Mock = vi.mocked(uploadToR2);
const deleteFromR2Mock = vi.mocked(deleteFromR2);

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL must be set to run tests');

const pool = new Pool({ connectionString: url });

const PUBLIC_BASE = 'https://photos.test';
const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const UUID_C = '33333333-3333-4333-8333-333333333333';

let jpeg: Buffer;

async function queued() {
  const { rows } = await pool.query<{ bucket: string; path: string; is_prefix: boolean }>(
    'SELECT bucket, path, is_prefix FROM r2_deletions ORDER BY id',
  );
  return rows;
}

async function resetDb() {
  await pool.query(
    'TRUNCATE accounts, guest_sessions, seeds, seed_photos, r2_deletions RESTART IDENTITY CASCADE',
  );
}

async function createUser(email: string, password = 'Password123!'): Promise<number> {
  const hash = await bcrypt.hash(password, 4);
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO accounts (email, password_hash, zone, zone_location_label, email_verified)
     VALUES ($1, $2, '7b', 'Test City', true)
     RETURNING id`,
    [email, hash],
  );
  return rows[0].id;
}

async function loginAgent(email: string, password = 'Password123!') {
  const agent = request.agent(app);
  await agent.post('/api/auth/guest');
  await agent.post('/api/auth/login').send({ email, password });
  return agent;
}

async function createSeed(agent: ReturnType<typeof request.agent>, name: string): Promise<string> {
  const res = await agent.post('/api/seeds').send({ commonName: name, plantFamily: 'Fam' });
  return res.body.id as string;
}

async function insertPhoto(seedId: string, uuid: string, notes: string | null = null, createdAt?: string) {
  const key = `seed-photos/${seedId}/${uuid}.jpg`;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO seed_photos (seed_id, storage_url, r2_key, notes, created_at)
     VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, now()))
     RETURNING id::text`,
    [seedId, `${PUBLIC_BASE}/${key}`, key, notes, createdAt ?? null],
  );
  return { id: rows[0].id, key };
}

function postPhoto(agent: ReturnType<typeof request.agent>, seedId: string, body: Buffer = jpeg) {
  return agent.post(`/api/seeds/${seedId}/photos`).set('Content-Type', 'image/jpeg').send(body);
}

// The key the route passed to the (mocked) uploadToR2 on its only call.
function uploadedKey(): string {
  expect(uploadToR2Mock).toHaveBeenCalledTimes(1);
  return uploadToR2Mock.mock.calls[0][0];
}

let supporter: ReturnType<typeof request.agent>;
let freeUser: ReturnType<typeof request.agent>;
let otherSupporter: ReturnType<typeof request.agent>;
let originalBase: string | undefined;

beforeAll(async () => {
  originalBase = process.env.R2_PUBLIC_BASE_URL;
  process.env.R2_PUBLIC_BASE_URL = `${PUBLIC_BASE}/`; // trailing slash is stripped

  jpeg = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#4a7' } })
    .jpeg()
    .toBuffer();

  await resetDb();
  const supporterId = await createUser('photos-supporter@example.com');
  await createUser('photos-free@example.com');
  const otherId = await createUser('photos-other@example.com');
  await pool.query(
    `UPDATE accounts SET subscription_tier = 'supporter' WHERE id = ANY($1)`,
    [[supporterId, otherId]],
  );

  supporter = await loginAgent('photos-supporter@example.com');
  freeUser = await loginAgent('photos-free@example.com');
  otherSupporter = await loginAgent('photos-other@example.com');
});

beforeEach(async () => {
  await pool.query('TRUNCATE r2_deletions RESTART IDENTITY');
  vi.mocked(drainSoon).mockClear();
  vi.mocked(processPhoto).mockClear();
  uploadToR2Mock.mockReset();
  uploadToR2Mock.mockImplementation(async (key: string) => `${PUBLIC_BASE}/${key}`);
  deleteFromR2Mock.mockReset();
  deleteFromR2Mock.mockResolvedValue(undefined);
});

afterAll(async () => {
  if (originalBase === undefined) delete process.env.R2_PUBLIC_BASE_URL;
  else process.env.R2_PUBLIC_BASE_URL = originalBase;
  await pool.end();
});

// ── Auth ──────────────────────────────────────────────────────────────────────

describe('Auth guards', () => {
  it('401 with no session on every route', async () => {
    const results = await Promise.all([
      request(app).get('/api/seeds/1/photos'),
      request(app).post('/api/seeds/1/photos').set('Content-Type', 'image/jpeg').send(jpeg),
      request(app).patch('/api/seeds/1/photos/1').send({ notes: 'x' }),
      request(app).delete('/api/seeds/1/photos/1'),
    ]);
    for (const r of results) expect(r.status).toBe(401);
  });
});

// ── Free account ──────────────────────────────────────────────────────────────

describe('Free account', () => {
  let seedId: string;
  let photoId: string;

  beforeAll(async () => {
    seedId = await createSeed(freeUser, 'Free Seed');
    ({ id: photoId } = await insertPhoto(seedId, UUID_A, 'old note'));
  });

  it('POST photo → 402 upgrade_required, nothing uploaded', async () => {
    const res = await postPhoto(freeUser, seedId);
    expect(res.status).toBe(402);
    expect(res.body.upgrade_required).toBe(true);
    expect(uploadToR2Mock).not.toHaveBeenCalled();
  });

  it('GET lists the existing photo', async () => {
    const res = await freeUser.get(`/api/seeds/${seedId}/photos`);
    expect(res.status).toBe(200);
    expect(res.body.photos).toHaveLength(1);
    expect(res.body.photos[0].id).toBe(photoId);
  });

  it('PATCH edits notes', async () => {
    const res = await freeUser
      .patch(`/api/seeds/${seedId}/photos/${photoId}`)
      .send({ notes: '  new note  ' });
    expect(res.status).toBe(200);
    expect(res.body.notes).toBe('new note');
  });

  it('DELETE removes the photo', async () => {
    const res = await freeUser.delete(`/api/seeds/${seedId}/photos/${photoId}`);
    expect(res.status).toBe(204);
  });
});

// ── Ownership ─────────────────────────────────────────────────────────────────

describe('Ownership', () => {
  let otherSeedId: string;
  let otherPhotoId: string;
  let mySeedId: string;

  beforeAll(async () => {
    otherSeedId = await createSeed(otherSupporter, 'Other Seed');
    ({ id: otherPhotoId } = await insertPhoto(otherSeedId, UUID_C));
    mySeedId = await createSeed(supporter, 'Ownership Seed');
  });

  it("another account's seed → 404 on every route", async () => {
    const results = await Promise.all([
      supporter.get(`/api/seeds/${otherSeedId}/photos`),
      postPhoto(supporter, otherSeedId),
      supporter.patch(`/api/seeds/${otherSeedId}/photos/${otherPhotoId}`).send({ notes: 'x' }),
      supporter.delete(`/api/seeds/${otherSeedId}/photos/${otherPhotoId}`),
    ]);
    for (const r of results) {
      expect(r.status).toBe(404);
      expect(r.body.error).toBe('Seed not found');
    }
    expect(uploadToR2Mock).not.toHaveBeenCalled();
    const { rows } = await pool.query('SELECT 1 FROM seed_photos WHERE id = $1', [otherPhotoId]);
    expect(rows).toHaveLength(1);
  });

  it('photoId from another seed → 404 on PATCH and DELETE', async () => {
    const patchRes = await supporter
      .patch(`/api/seeds/${mySeedId}/photos/${otherPhotoId}`)
      .send({ notes: 'x' });
    expect(patchRes.status).toBe(404);
    expect(patchRes.body.error).toBe('Photo not found');

    const delRes = await supporter.delete(`/api/seeds/${mySeedId}/photos/${otherPhotoId}`);
    expect(delRes.status).toBe(404);
    expect(delRes.body.error).toBe('Photo not found');
    expect(deleteFromR2Mock).not.toHaveBeenCalled();
  });

  it('non-numeric ids → 400', async () => {
    const r1 = await supporter.get('/api/seeds/abc/photos');
    expect(r1.status).toBe(400);
    const r2 = await supporter.patch(`/api/seeds/${mySeedId}/photos/abc`).send({ notes: 'x' });
    expect(r2.status).toBe(400);
  });
});

// ── POST photo ────────────────────────────────────────────────────────────────

describe('POST photo', () => {
  it('raw JPEG → 201; re-encoded JPEG uploaded under this seed; row stored', async () => {
    const seedId = await createSeed(supporter, 'Upload Seed');
    const res = await postPhoto(supporter, seedId);
    expect(res.status).toBe(201);
    expect(Object.keys(res.body).sort()).toEqual(['createdAt', 'id', 'notes', 'url']);
    expect(typeof res.body.id).toBe('string');
    expect(res.body.notes).toBeNull();

    const key = uploadedKey();
    expect(key).toMatch(new RegExp(`^seed-photos/${seedId}/[0-9a-f-]{36}\\.jpg$`));
    const [, body, contentType] = uploadToR2Mock.mock.calls[0];
    expect(Buffer.isBuffer(body)).toBe(true);
    expect([...(body as Buffer).subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    expect(contentType).toBe('image/jpeg');
    expect(res.body.url).toBe(`${PUBLIC_BASE}/${key}`);

    const { rows } = await pool.query<{ storage_url: string; r2_key: string }>(
      'SELECT storage_url, r2_key FROM seed_photos WHERE id = $1',
      [res.body.id],
    );
    expect(rows[0]).toEqual({ storage_url: `${PUBLIC_BASE}/${key}`, r2_key: key });
    expect(await queued()).toEqual([]);
  });

  it('X-Photo-Notes header is decoded and stored', async () => {
    const seedId = await createSeed(supporter, 'Notes Seed');
    const res = await postPhoto(supporter, seedId).set(
      'X-Photo-Notes',
      encodeURIComponent('  Sown 3 Mar ✓  '),
    );
    expect(res.status).toBe(201);
    expect(res.body.notes).toBe('Sown 3 Mar ✓');
  });

  it('blank notes are stored as null', async () => {
    const seedId = await createSeed(supporter, 'Blank Notes Seed');
    const res = await postPhoto(supporter, seedId).set('X-Photo-Notes', '%20%20');
    expect(res.status).toBe(201);
    expect(res.body.notes).toBeNull();
  });

  it('malformed notes encoding → 400, nothing uploaded', async () => {
    const seedId = await createSeed(supporter, 'Bad Notes Seed');
    const res = await postPhoto(supporter, seedId).set('X-Photo-Notes', '%E0%A4%A');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Notes must be text.');
    expect(uploadToR2Mock).not.toHaveBeenCalled();
  });

  it('notes over 500 chars → 400', async () => {
    const seedId = await createSeed(supporter, 'Long Notes Seed');
    const res = await postPhoto(supporter, seedId).set('X-Photo-Notes', 'a'.repeat(501));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Notes must be 500 characters or fewer.');
    expect(uploadToR2Mock).not.toHaveBeenCalled();
  });

  it('a JSON body → 400, nothing uploaded', async () => {
    const seedId = await createSeed(supporter, 'Json Seed');
    const res = await supporter
      .post(`/api/seeds/${seedId}/photos`)
      .send({ key: `seed-photos/${seedId}/${UUID_A}.jpg` });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("That file isn't a supported image.");
    expect(uploadToR2Mock).not.toHaveBeenCalled();
  });

  it('text bytes sent as image/jpeg → 400, nothing uploaded', async () => {
    const seedId = await createSeed(supporter, 'Text Seed');
    const res = await postPhoto(supporter, seedId, Buffer.from('hello, not an image'));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("That file isn't a supported image.");
    expect(uploadToR2Mock).not.toHaveBeenCalled();
  });

  it('a body over 5 MB → 413', async () => {
    const seedId = await createSeed(supporter, 'Big Seed');
    const res = await postPhoto(supporter, seedId, Buffer.alloc(5 * 1024 * 1024 + 1));
    expect(res.status).toBe(413);
    expect(uploadToR2Mock).not.toHaveBeenCalled();
  });

  it('busy image limiter → 503, nothing uploaded', async () => {
    const seedId = await createSeed(supporter, 'Busy Seed');
    vi.mocked(processPhoto).mockRejectedValueOnce(new ImageBusyError());
    const res = await postPhoto(supporter, seedId);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('Busy, try again.');
    expect(uploadToR2Mock).not.toHaveBeenCalled();
  });

  it('R2_PUBLIC_BASE_URL unset → 503, nothing uploaded', async () => {
    const seedId = await createSeed(supporter, 'No Base Seed');
    const saved = process.env.R2_PUBLIC_BASE_URL;
    delete process.env.R2_PUBLIC_BASE_URL;
    try {
      const res = await postPhoto(supporter, seedId);
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('Photo storage is not configured.');
      expect(uploadToR2Mock).not.toHaveBeenCalled();
    } finally {
      process.env.R2_PUBLIC_BASE_URL = saved;
    }
  });

  it('R2 not configured → 503, nothing queued', async () => {
    const seedId = await createSeed(supporter, 'No R2 Seed');
    uploadToR2Mock.mockRejectedValueOnce(new Error('R2 not configured: R2_ACCOUNT_ID ...'));
    const res = await postPhoto(supporter, seedId);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('Photo storage is not configured.');
    expect(await queued()).toEqual([]);
  });

  it('any other R2 error → 500', async () => {
    const seedId = await createSeed(supporter, 'R2 Down Seed');
    uploadToR2Mock.mockRejectedValueOnce(new Error('network down'));
    const res = await postPhoto(supporter, seedId);
    expect(res.status).toBe(500);
  });

  it('the limit is reached while uploading → 409 and the upload is queued for deletion', async () => {
    const seedId = await createSeed(supporter, 'Race Seed');
    await insertPhoto(seedId, UUID_A);
    await insertPhoto(seedId, UUID_B);
    uploadToR2Mock.mockImplementationOnce(async (key: string) => {
      await insertPhoto(seedId, UUID_C);
      return `${PUBLIC_BASE}/${key}`;
    });
    const res = await postPhoto(supporter, seedId);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Up to 3 photos per seed.');
    const key = uploadedKey();
    expect(await queued()).toEqual([{ bucket: 'public', path: key, is_prefix: false }]);
    expect(drainSoon).toHaveBeenCalled();
    const { rows } = await pool.query('SELECT 1 FROM seed_photos WHERE r2_key = $1', [key]);
    expect(rows).toHaveLength(0);
  });

  it('the seed is deleted while uploading → 404 and the upload is queued for deletion', async () => {
    const seedId = await createSeed(supporter, 'Vanishing Seed');
    uploadToR2Mock.mockImplementationOnce(async (key: string) => {
      await pool.query('DELETE FROM seeds WHERE id = $1', [seedId]);
      return `${PUBLIC_BASE}/${key}`;
    });
    const res = await postPhoto(supporter, seedId);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Seed not found');
    expect(await queued()).toEqual([{ bucket: 'public', path: uploadedKey(), is_prefix: false }]);
    expect(drainSoon).toHaveBeenCalled();
  });

  it('the insert fails after upload → 500 and the upload is queued for deletion', async () => {
    const seedId = await createSeed(supporter, 'Insert Fail Seed');
    const otherSeedId = await createSeed(supporter, 'Insert Fail Other Seed');
    // r2_key is UNIQUE: another row taking the key makes the INSERT fail.
    uploadToR2Mock.mockImplementationOnce(async (key: string) => {
      await pool.query(
        'INSERT INTO seed_photos (seed_id, storage_url, r2_key) VALUES ($1, $2, $3)',
        [otherSeedId, `${PUBLIC_BASE}/${key}`, key],
      );
      return `${PUBLIC_BASE}/${key}`;
    });
    const res = await postPhoto(supporter, seedId);
    expect(res.status).toBe(500);
    expect(await queued()).toEqual([{ bucket: 'public', path: uploadedKey(), is_prefix: false }]);
    expect(drainSoon).toHaveBeenCalled();
  });

  it('POST upload-url → 404 (removed)', async () => {
    const seedId = await createSeed(supporter, 'Old Flow Seed');
    const res = await supporter
      .post(`/api/seeds/${seedId}/photos/upload-url`)
      .send({ contentType: 'image/jpeg', size: 1000 });
    expect(res.status).toBe(404);
  });
});

// ── Limit ─────────────────────────────────────────────────────────────────────

describe('Three-photo limit', () => {
  let seedId: string;

  beforeAll(async () => {
    seedId = await createSeed(supporter, 'Full Seed');
    await insertPhoto(seedId, UUID_A);
    await insertPhoto(seedId, UUID_B);
    await insertPhoto(seedId, UUID_C);
  });

  it('a fourth photo → 409 without uploading', async () => {
    const res = await postPhoto(supporter, seedId);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Up to 3 photos per seed.');
    expect(uploadToR2Mock).not.toHaveBeenCalled();
    expect(processPhoto).not.toHaveBeenCalled();
  });
});

// ── GET ───────────────────────────────────────────────────────────────────────

describe('GET photos', () => {
  let seedId: string;
  let oldId: string;
  let newId: string;

  beforeAll(async () => {
    seedId = await createSeed(supporter, 'List Seed');
    ({ id: oldId } = await insertPhoto(seedId, UUID_A, 'old', '2026-01-01T00:00:00Z'));
    ({ id: newId } = await insertPhoto(seedId, UUID_B, null, '2026-06-01T00:00:00Z'));
  });

  it('returns newest first with string ids and camelCase keys', async () => {
    const res = await supporter.get(`/api/seeds/${seedId}/photos`);
    expect(res.status).toBe(200);
    expect(res.body.photos.map((p: { id: string }) => p.id)).toEqual([newId, oldId]);
    const photo = res.body.photos[1];
    expect(Object.keys(photo).sort()).toEqual(['createdAt', 'id', 'notes', 'url']);
    expect(typeof photo.id).toBe('string');
    expect(photo.notes).toBe('old');
    expect(photo.url).toBe(`${PUBLIC_BASE}/seed-photos/${seedId}/${UUID_A}.jpg`);
  });

  it('builds url from R2_PUBLIC_BASE_URL and r2_key, not an outdated storage_url', async () => {
    const sid = await createSeed(supporter, 'Outdated Url Seed');
    const key = `seed-photos/${sid}/${UUID_C}.jpg`;
    await pool.query(
      `INSERT INTO seed_photos (seed_id, storage_url, r2_key) VALUES ($1, $2, $3)`,
      [sid, `https://old-cdn.example.com/${key}`, key],
    );
    const res = await supporter.get(`/api/seeds/${sid}/photos`);
    expect(res.status).toBe(200);
    expect(res.body.photos[0].url).toBe(`${PUBLIC_BASE}/${key}`);
  });
});

// ── DELETE ────────────────────────────────────────────────────────────────────

describe('DELETE photo', () => {
  let seedId: string;

  beforeAll(async () => {
    seedId = await createSeed(supporter, 'Delete Photo Seed');
  });

  it('204, row gone, file queued', async () => {
    const { id, key } = await insertPhoto(seedId, UUID_A);
    const res = await supporter.delete(`/api/seeds/${seedId}/photos/${id}`);
    expect(res.status).toBe(204);
    const { rows } = await pool.query('SELECT 1 FROM seed_photos WHERE id = $1', [id]);
    expect(rows).toHaveLength(0);
    expect(await queued()).toEqual([{ bucket: 'public', path: key, is_prefix: false }]);
    expect(drainSoon).toHaveBeenCalled();
  });

  it('a photo id that does not exist → 404 and queues nothing', async () => {
    const res = await supporter.delete(`/api/seeds/${seedId}/photos/999999`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Photo not found');
    expect(await queued()).toEqual([]);
  });
});

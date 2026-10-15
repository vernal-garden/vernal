import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { Pool } from 'pg';

vi.mock('../lib/r2', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/r2')>()),
  getPresignedUploadUrl: vi.fn(),
  deleteFromR2: vi.fn(),
}));

import { getPresignedUploadUrl, deleteFromR2 } from '../lib/r2';
import app from '../index';

const getPresignedUploadUrlMock = vi.mocked(getPresignedUploadUrl);
const deleteFromR2Mock = vi.mocked(deleteFromR2);

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL must be set to run tests');

const pool = new Pool({ connectionString: url });

const PUBLIC_BASE = 'https://photos.test';
const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const UUID_C = '33333333-3333-4333-8333-333333333333';
const UUID_D = '44444444-4444-4444-8444-444444444444';

async function resetDb() {
  await pool.query(
    'TRUNCATE accounts, guest_sessions, seeds, seed_photos RESTART IDENTITY CASCADE',
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

let supporter: ReturnType<typeof request.agent>;
let freeUser: ReturnType<typeof request.agent>;
let otherSupporter: ReturnType<typeof request.agent>;
let originalBase: string | undefined;

beforeAll(async () => {
  originalBase = process.env.R2_PUBLIC_BASE_URL;
  process.env.R2_PUBLIC_BASE_URL = `${PUBLIC_BASE}/`; // trailing slash is stripped

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

beforeEach(() => {
  getPresignedUploadUrlMock.mockReset();
  getPresignedUploadUrlMock.mockResolvedValue('https://r2.test/put');
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
      request(app).post('/api/seeds/1/photos/upload-url').send({ contentType: 'image/jpeg', size: 1000 }),
      request(app).post('/api/seeds/1/photos').send({ key: `seed-photos/1/${UUID_A}.jpg` }),
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

  it('upload-url → 402 upgrade_required', async () => {
    const res = await freeUser
      .post(`/api/seeds/${seedId}/photos/upload-url`)
      .send({ contentType: 'image/jpeg', size: 1000 });
    expect(res.status).toBe(402);
    expect(res.body.upgrade_required).toBe(true);
  });

  it('confirm → 402 upgrade_required', async () => {
    const res = await freeUser
      .post(`/api/seeds/${seedId}/photos`)
      .send({ key: `seed-photos/${seedId}/${UUID_B}.jpg` });
    expect(res.status).toBe(402);
    expect(res.body.upgrade_required).toBe(true);
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
      supporter.post(`/api/seeds/${otherSeedId}/photos/upload-url`).send({ contentType: 'image/jpeg', size: 1000 }),
      supporter.post(`/api/seeds/${otherSeedId}/photos`).send({ key: `seed-photos/${otherSeedId}/${UUID_D}.jpg` }),
      supporter.patch(`/api/seeds/${otherSeedId}/photos/${otherPhotoId}`).send({ notes: 'x' }),
      supporter.delete(`/api/seeds/${otherSeedId}/photos/${otherPhotoId}`),
    ]);
    for (const r of results) {
      expect(r.status).toBe(404);
      expect(r.body.error).toBe('Seed not found');
    }
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

// ── upload-url ────────────────────────────────────────────────────────────────

describe('POST upload-url', () => {
  let seedId: string;

  beforeAll(async () => {
    seedId = await createSeed(supporter, 'Upload Seed');
  });

  it('image/jpeg, size 1000000 → 200 with a key for this seed', async () => {
    const res = await supporter
      .post(`/api/seeds/${seedId}/photos/upload-url`)
      .send({ contentType: 'image/jpeg', size: 1000000 });
    expect(res.status).toBe(200);
    expect(res.body.uploadUrl).toBe('https://r2.test/put');
    expect(res.body.key).toMatch(
      new RegExp(`^seed-photos/${seedId}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.jpg$`),
    );
    expect(getPresignedUploadUrlMock).toHaveBeenCalledWith(res.body.key, 'image/jpeg', 1000000, 300);
  });

  it('image/png → 400', async () => {
    const res = await supporter
      .post(`/api/seeds/${seedId}/photos/upload-url`)
      .send({ contentType: 'image/png', size: 1000 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Photos must be JPEG.');
  });

  it.each([
    ['no size', undefined],
    ['size 0', 0],
    ['size over 5 MB', 5 * 1024 * 1024 + 1],
    ['fractional size', 2.5],
  ])('%s → 400', async (_label, size) => {
    const res = await supporter
      .post(`/api/seeds/${seedId}/photos/upload-url`)
      .send({ contentType: 'image/jpeg', size });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Photos must be 5 MB or smaller.');
    expect(getPresignedUploadUrlMock).not.toHaveBeenCalled();
  });

  it("R2 not configured → 503", async () => {
    getPresignedUploadUrlMock.mockRejectedValue(new Error('R2 not configured: R2_ACCOUNT_ID ...'));
    const res = await supporter
      .post(`/api/seeds/${seedId}/photos/upload-url`)
      .send({ contentType: 'image/jpeg', size: 1000 });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('Photo storage is not configured.');
  });

  it('any other R2 error → 500', async () => {
    getPresignedUploadUrlMock.mockRejectedValue(new Error('network down'));
    const res = await supporter
      .post(`/api/seeds/${seedId}/photos/upload-url`)
      .send({ contentType: 'image/jpeg', size: 1000 });
    expect(res.status).toBe(500);
  });
});

// ── confirm ───────────────────────────────────────────────────────────────────

describe('POST confirm', () => {
  let seedId: string;
  let otherSeedId: string;

  beforeAll(async () => {
    seedId = await createSeed(supporter, 'Confirm Seed');
    otherSeedId = await createSeed(supporter, 'Confirm Other Seed');
  });

  it('valid key → 201, storage_url and r2_key stored', async () => {
    const key = `seed-photos/${seedId}/${UUID_A}.jpg`;
    const res = await supporter.post(`/api/seeds/${seedId}/photos`).send({ key, notes: '  first  ' });
    expect(res.status).toBe(201);
    expect(typeof res.body.id).toBe('string');
    expect(res.body.url).toBe(`${PUBLIC_BASE}/${key}`);
    expect(res.body.notes).toBe('first');

    const { rows } = await pool.query<{ storage_url: string; r2_key: string }>(
      'SELECT storage_url, r2_key FROM seed_photos WHERE id = $1',
      [res.body.id],
    );
    expect(rows[0].storage_url).toBe(`${PUBLIC_BASE}/${key}`);
    expect(rows[0].r2_key).toBe(key);
  });

  it('empty notes are stored as null', async () => {
    const key = `seed-photos/${otherSeedId}/${UUID_B}.jpg`;
    const res = await supporter.post(`/api/seeds/${otherSeedId}/photos`).send({ key, notes: '   ' });
    expect(res.status).toBe(201);
    expect(res.body.notes).toBeNull();
  });

  it('key with another seed id → 400', async () => {
    const res = await supporter
      .post(`/api/seeds/${seedId}/photos`)
      .send({ key: `seed-photos/${otherSeedId}/${UUID_C}.jpg` });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid photo key.');
  });

  it('non-UUID key → 400', async () => {
    const res = await supporter
      .post(`/api/seeds/${seedId}/photos`)
      .send({ key: `seed-photos/${seedId}/not-a-uuid.jpg` });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid photo key.');
  });

  it('same key twice → 409', async () => {
    const res = await supporter
      .post(`/api/seeds/${seedId}/photos`)
      .send({ key: `seed-photos/${seedId}/${UUID_A}.jpg` });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Photo already added.');
  });

  it('notes over 500 chars → 400', async () => {
    const res = await supporter
      .post(`/api/seeds/${seedId}/photos`)
      .send({ key: `seed-photos/${seedId}/${UUID_D}.jpg`, notes: 'a'.repeat(501) });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Notes must be 500 characters or fewer.');
  });

  it('R2_PUBLIC_BASE_URL unset → 503', async () => {
    const saved = process.env.R2_PUBLIC_BASE_URL;
    delete process.env.R2_PUBLIC_BASE_URL;
    try {
      const res = await supporter
        .post(`/api/seeds/${seedId}/photos`)
        .send({ key: `seed-photos/${seedId}/${UUID_D}.jpg` });
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('Photo storage is not configured.');
    } finally {
      process.env.R2_PUBLIC_BASE_URL = saved;
    }
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

  it('a fourth photo → 409 from upload-url', async () => {
    const res = await supporter
      .post(`/api/seeds/${seedId}/photos/upload-url`)
      .send({ contentType: 'image/jpeg', size: 1000 });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Up to 3 photos per seed.');
    expect(getPresignedUploadUrlMock).not.toHaveBeenCalled();
  });

  it('a fourth photo → 409 from confirm', async () => {
    const res = await supporter
      .post(`/api/seeds/${seedId}/photos`)
      .send({ key: `seed-photos/${seedId}/${UUID_D}.jpg` });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Up to 3 photos per seed.');
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

  it('204, row gone, deleteFromR2 called with the key', async () => {
    const { id, key } = await insertPhoto(seedId, UUID_A);
    const res = await supporter.delete(`/api/seeds/${seedId}/photos/${id}`);
    expect(res.status).toBe(204);
    const { rows } = await pool.query('SELECT 1 FROM seed_photos WHERE id = $1', [id]);
    expect(rows).toHaveLength(0);
    expect(deleteFromR2Mock).toHaveBeenCalledWith(key);
  });

  it('deleteFromR2 rejecting still returns 204', async () => {
    deleteFromR2Mock.mockRejectedValue(new Error('R2 down'));
    const { id } = await insertPhoto(seedId, UUID_B);
    const res = await supporter.delete(`/api/seeds/${seedId}/photos/${id}`);
    expect(res.status).toBe(204);
  });
});

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { Pool } from 'pg';

vi.mock('../lib/r2', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/r2')>()),
  getMediaRedirectUrl: vi.fn(async (key: string) => `https://signed.test/${key}`),
}));

import { getMediaRedirectUrl } from '../lib/r2';
import app from '../index';

const getMediaRedirectUrlMock = vi.mocked(getMediaRedirectUrl);

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL must be set to run tests');

const pool = new Pool({ connectionString: url });

type Agent = ReturnType<typeof request.agent>;

async function resetDb() {
  await pool.query(
    `TRUNCATE accounts, guest_sessions, gardens, seeds, seed_photos, harvest_entries
       RESTART IDENTITY CASCADE`,
  );
}

async function createUser(email: string): Promise<number> {
  const hash = await bcrypt.hash('Password123!', 4);
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO accounts (email, password_hash, zone, zone_location_label, email_verified)
     VALUES ($1, $2, '7b', 'Test City', true)
     RETURNING id`,
    [email, hash],
  );
  return rows[0].id;
}

async function loginAgent(email: string): Promise<Agent> {
  const agent = request.agent(app);
  await agent.post('/api/auth/guest');
  await agent.post('/api/auth/login').send({ email, password: 'Password123!' });
  return agent;
}

async function guestAgent(): Promise<Agent> {
  const agent = request.agent(app);
  await agent.post('/api/auth/guest').expect(201);
  return agent;
}

async function createGarden(agent: Agent, name = 'Garden'): Promise<number> {
  const res = await agent
    .post('/api/gardens')
    .send({ name, style: 'grid', zone: '7b', growingMethod: 'in_ground' });
  expect(res.status).toBe(201);
  return Number(res.body.id);
}

async function guestSessionOf(gardenId: number): Promise<string> {
  const { rows } = await pool.query<{ guest_session_id: string }>(
    'SELECT guest_session_id FROM gardens WHERE id = $1',
    [gardenId],
  );
  return rows[0].guest_session_id;
}

async function createSeed(owner: { accountId?: number; guestSessionId?: string }): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO seeds (owner_id, guest_session_id, common_name, plant_family, origin)
     VALUES ($1, $2, $3, 'Fam', 'user_created') RETURNING id`,
    [owner.accountId ?? null, owner.guestSessionId ?? null, crypto.randomUUID()],
  );
  return rows[0].id;
}

/** A seed_photos row for the seed; returns its id and key. */
async function createSeedPhoto(seedId: number): Promise<{ id: number; key: string }> {
  const key = `seed-photos/${seedId}/${crypto.randomUUID()}.jpg`;
  const { rows } = await pool.query<{ id: number }>(
    'INSERT INTO seed_photos (seed_id, storage_url, r2_key) VALUES ($1, $2, $3) RETURNING id',
    [seedId, key, key],
  );
  return { id: rows[0].id, key };
}

/** A harvest entry in the garden with one photo; returns its id and the photo key. */
async function createHarvestPhoto(gardenId: number): Promise<{ id: number; key: string }> {
  const { rows } = await pool.query<{ id: number }>(
    'INSERT INTO harvest_entries (garden_id) VALUES ($1) RETURNING id',
    [gardenId],
  );
  const id = rows[0].id;
  const key = `harvest-photos/${id}/${crypto.randomUUID()}.jpg`;
  await pool.query('UPDATE harvest_entries SET photos = $2::jsonb WHERE id = $1', [
    id,
    JSON.stringify([{ key }]),
  ]);
  return { id, key };
}

async function setThumbnail(gardenId: number, stored?: string): Promise<string> {
  const key = `garden-thumbnails/${gardenId}/${crypto.randomUUID()}.png`;
  await pool.query('UPDATE gardens SET thumbnail_url = $1 WHERE id = $2', [
    stored ? stored + key : key,
    gardenId,
  ]);
  return key;
}

interface Fixtures {
  owner: Agent;
  other: Agent;
  guest: Agent;
  seedPhoto: { id: number; key: string };
  harvestPhoto: { id: number; key: string };
  thumbnail: string;
  gardenId: number;
  guestHarvestPhoto: string;
  guestThumbnail: string;
  guestSeedPhoto: string;
}

let f: Fixtures;

beforeEach(async () => {
  await resetDb();
  getMediaRedirectUrlMock.mockClear();

  const ownerEmail = `${crypto.randomUUID()}@example.com`;
  const otherEmail = `${crypto.randomUUID()}@example.com`;
  const ownerId = await createUser(ownerEmail);
  const otherId = await createUser(otherEmail);
  const owner = await loginAgent(ownerEmail);
  const other = await loginAgent(otherEmail);
  const guest = await guestAgent();

  const gardenId = await createGarden(owner);
  await createGarden(other);
  const guestGardenId = await createGarden(guest);
  const guestSessionId = await guestSessionOf(guestGardenId);

  const seedPhoto = await createSeedPhoto(await createSeed({ accountId: ownerId }));
  await createSeedPhoto(await createSeed({ accountId: otherId }));

  f = {
    owner,
    other,
    guest,
    seedPhoto,
    harvestPhoto: await createHarvestPhoto(gardenId),
    thumbnail: await setThumbnail(gardenId),
    gardenId,
    guestHarvestPhoto: (await createHarvestPhoto(guestGardenId)).key,
    guestThumbnail: await setThumbnail(guestGardenId),
    guestSeedPhoto: (await createSeedPhoto(await createSeed({ guestSessionId }))).key,
  };
});

afterAll(async () => {
  await pool.end();
});

function expectRedirect(res: request.Response, key: string) {
  expect(res.status).toBe(302);
  expect(res.headers.location).toBe(`https://signed.test/${key}`);
  const cacheControl = res.headers['cache-control'];
  expect(cacheControl).toMatch(/^private, max-age=\d+$/);
  const maxAge = Number(cacheControl.split('=')[1]);
  expect(maxAge).toBeGreaterThanOrEqual(60);
  expect(maxAge).toBeLessThanOrEqual(3600);
}

function expectNotFound(res: request.Response) {
  expect(res.status).toBe(404);
  expect(res.body).toEqual({ error: 'Not found' });
}

describe('GET /api/media/*', () => {
  it('redirects the owner to a signed link for each kind', async () => {
    for (const key of [f.seedPhoto.key, f.harvestPhoto.key, f.thumbnail]) {
      expectRedirect(await f.owner.get(`/api/media/${key}`), key);
    }
  });

  it('returns 404 to another account for each kind', async () => {
    for (const key of [f.seedPhoto.key, f.harvestPhoto.key, f.thumbnail]) {
      expectNotFound(await f.other.get(`/api/media/${key}`));
    }
    expect(getMediaRedirectUrlMock).not.toHaveBeenCalled();
  });

  it("serves a guest its own garden's thumbnail and harvest photo, never a seed photo", async () => {
    expectRedirect(await f.guest.get(`/api/media/${f.guestThumbnail}`), f.guestThumbnail);
    expectRedirect(await f.guest.get(`/api/media/${f.guestHarvestPhoto}`), f.guestHarvestPhoto);
    expectNotFound(await f.guest.get(`/api/media/${f.guestSeedPhoto}`));
    expectNotFound(await f.guest.get(`/api/media/${f.seedPhoto.key}`));
  });

  it('returns 404 for a well-formed key no row references', async () => {
    const keys = [
      `seed-photos/${f.seedPhoto.key.split('/')[1]}/${crypto.randomUUID()}.jpg`,
      `harvest-photos/${f.harvestPhoto.id}/${crypto.randomUUID()}.jpg`,
      `garden-thumbnails/${f.gardenId}/${crypto.randomUUID()}.png`,
    ];
    for (const key of keys) {
      expectNotFound(await f.owner.get(`/api/media/${key}`));
    }
  });

  it('returns 404 for a malformed key', async () => {
    for (const key of ['seed-photos/1/x.jpg', '../etc/passwd', '..%2Fetc%2Fpasswd', 'exports/1/2.zip']) {
      expectNotFound(await f.owner.get(`/api/media/${key}`));
    }
    expect(getMediaRedirectUrlMock).not.toHaveBeenCalled();
  });

  it('returns 404 once a photo is deleted or a thumbnail replaced', async () => {
    await pool.query('DELETE FROM seed_photos WHERE id = $1', [f.seedPhoto.id]);
    expectNotFound(await f.owner.get(`/api/media/${f.seedPhoto.key}`));

    await pool.query(`UPDATE harvest_entries SET photos = '[]'::jsonb WHERE id = $1`, [
      f.harvestPhoto.id,
    ]);
    expectNotFound(await f.owner.get(`/api/media/${f.harvestPhoto.key}`));

    const newThumbnail = await setThumbnail(f.gardenId);
    expectNotFound(await f.owner.get(`/api/media/${f.thumbnail}`));
    expectRedirect(await f.owner.get(`/api/media/${newThumbnail}`), newThumbnail);
  });

  it('returns 404 without a session cookie', async () => {
    expectNotFound(await request(app).get(`/api/media/${f.thumbnail}`));
  });

  it('returns 503 when photo storage is not configured', async () => {
    getMediaRedirectUrlMock.mockRejectedValueOnce(new Error('R2_BUCKET_NAME is not set.'));
    const res = await f.owner.get(`/api/media/${f.thumbnail}`);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'Photo storage is not configured.' });
  });

  it('accepts a thumbnail stored as an old public URL', async () => {
    const key = await setThumbnail(f.gardenId, 'https://pub-x.r2.dev/');
    expectRedirect(await f.owner.get(`/api/media/${key}`), key);
  });
});

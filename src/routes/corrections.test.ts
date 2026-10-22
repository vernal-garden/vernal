import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { Pool } from 'pg';
import app from '../index';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL must be set to run tests');

const pool = new Pool({ connectionString: url });

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

async function cambiumSeed(name: string): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO cambium.seeds (common_name, moderation_status, source)
     VALUES ($1, 'active', 'editorial') RETURNING id`,
    [name],
  );
  return rows[0].id;
}

async function addCorrection(accountId: number, cambiumSeedId: number, ageHours = 0) {
  await pool.query(
    `INSERT INTO moderation_items (type, cambium_seed_id, submitted_by, content, created_at)
     VALUES ('correction', $1, $2, '{"correctionText":"x"}', now() - make_interval(hours => $3))`,
    [cambiumSeedId, accountId, ageHours],
  );
}

let agent: ReturnType<typeof request.agent>;
let accountId: number;

beforeAll(async () => {
  await pool.query('TRUNCATE accounts, guest_sessions, moderation_items RESTART IDENTITY CASCADE');
  await pool.query('TRUNCATE cambium.seeds RESTART IDENTITY CASCADE');
  accountId = await createUser('corrections-user@example.com');
  agent = await loginAgent('corrections-user@example.com');
});

afterAll(() => pool.end());

describe('POST /api/corrections — daily cap', () => {
  it('429s the 11th correction in 24h; rows older than 24h do not count', async () => {
    // 5 old rows (don't count) + 10 fresh ones fill the day
    for (let i = 0; i < 5; i++) await addCorrection(accountId, await cambiumSeed(`Old ${i}`), 30);
    for (let i = 0; i < 9; i++) await addCorrection(accountId, await cambiumSeed(`Fresh ${i}`));

    const tenth = await cambiumSeed('Tenth');
    const ok = await agent.post('/api/corrections').send({ cambiumSeedId: tenth, correctionText: 'fix' });
    expect(ok.status).toBe(201);

    const eleventh = await cambiumSeed('Eleventh');
    const res = await agent.post('/api/corrections').send({ cambiumSeedId: eleventh, correctionText: 'fix' });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("You've sent 10 corrections today. Please try again tomorrow.");
  });
});

describe('POST /api/corrections — parallel submissions at the cap', () => {
  it('with 9 in the last 24h, 3 parallel POSTs → exactly one 201 and two 429', async () => {
    const id = await createUser('corrections-race@example.com');
    const raceAgent = await loginAgent('corrections-race@example.com');
    for (let i = 0; i < 9; i++) await addCorrection(id, await cambiumSeed(`Race fill ${i}`));
    const seeds: number[] = [];
    for (let i = 0; i < 3; i++) seeds.push(await cambiumSeed(`Race ${i}`));

    const results = await Promise.all(
      seeds.map((s) => raceAgent.post('/api/corrections').send({ cambiumSeedId: s, correctionText: 'fix' })),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 429, 429]);

    const { rows } = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM moderation_items WHERE type = 'correction' AND submitted_by = $1`,
      [id],
    );
    expect(rows[0].n).toBe(10);
  });
});

describe('POST /api/corrections — one open per seed', () => {
  let agent2: ReturnType<typeof request.agent>;
  let seedId: number;

  beforeAll(async () => {
    await createUser('corrections-user2@example.com');
    agent2 = await loginAgent('corrections-user2@example.com');
    seedId = await cambiumSeed('Dedupe Seed');
  });

  it('409s a second open correction for the same seed, allows after resolution', async () => {
    const first = await agent2.post('/api/corrections').send({ cambiumSeedId: seedId, correctionText: 'one' });
    expect(first.status).toBe(201);

    const dup = await agent2.post('/api/corrections').send({ cambiumSeedId: seedId, correctionText: 'two' });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('You already have a pending correction for this seed.');

    await pool.query(
      `UPDATE moderation_items SET status = 'approved' WHERE cambium_seed_id = $1 AND type = 'correction'`,
      [seedId],
    );
    const again = await agent2.post('/api/corrections').send({ cambiumSeedId: seedId, correctionText: 'three' });
    expect(again.status).toBe(201);
  });
});

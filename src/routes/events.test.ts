import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { readFileSync } from 'fs';
import path from 'path';
import { Pool } from 'pg';
import app from '../index';
import { EVENT_KEYS } from '../lib/eventKeys';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL must be set to run tests');

const pool = new Pool({ connectionString: url });

async function resetDb() {
  await pool.query('TRUNCATE accounts, guest_sessions, usage_events RESTART IDENTITY CASCADE');
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

interface EventRow {
  user_id: number | null;
  session_id: string;
  event_key: string;
  created_at: Date;
}

async function eventRows(): Promise<EventRow[]> {
  const { rows } = await pool.query<EventRow>(
    'SELECT user_id, session_id, event_key, created_at FROM usage_events ORDER BY id',
  );
  return rows;
}

// ── Fixtures ────────────────────────────────────────────────────────────────

let guestAgent: ReturnType<typeof request.agent>;
let guestSessionId: string;
let accountAgent: ReturnType<typeof request.agent>;
let accountId: number;
let accountSessionId: string;

beforeAll(async () => {
  await resetDb();

  guestAgent = request.agent(app);
  await guestAgent.post('/api/auth/guest');
  const guestRow = await pool.query<{ id: string }>(
    'SELECT id FROM guest_sessions ORDER BY created_at DESC LIMIT 1',
  );
  guestSessionId = guestRow.rows[0].id;

  accountId = await createUser('events-user@example.com');
  accountAgent = request.agent(app);
  await accountAgent.post('/api/auth/guest');
  await accountAgent.post('/api/auth/login').send({ email: 'events-user@example.com', password: 'Password123!' });
  const accountRow = await pool.query<{ id: string }>(
    'SELECT id FROM guest_sessions WHERE account_id = $1',
    [accountId],
  );
  accountSessionId = accountRow.rows[0].id;
});

beforeEach(async () => {
  await pool.query('TRUNCATE usage_events RESTART IDENTITY');
});

afterAll(() => pool.end());

// ── POST /api/events/batch ──────────────────────────────────────────────────

describe('POST /api/events/batch', () => {
  it('returns 401 without a session cookie', async () => {
    const res = await request(app)
      .post('/api/events/batch')
      .send({ events: [{ event_key: 'canvas_session' }] });
    expect(res.status).toBe(401);
    expect(await eventRows()).toHaveLength(0);
  });

  it('stores guest events with user_id NULL and the guest session id', async () => {
    const res = await guestAgent
      .post('/api/events/batch')
      .send({ events: [{ event_key: 'canvas_session' }, { event_key: 'canvas_plant_placed' }] });
    expect(res.status).toBe(204);
    expect(res.text).toBe('');

    const rows = await eventRows();
    expect(rows.map((r) => r.event_key)).toEqual(['canvas_session', 'canvas_plant_placed']);
    for (const row of rows) {
      expect(row.user_id).toBeNull();
      expect(row.session_id).toBe(guestSessionId);
    }
  });

  it('stores account events with the account id', async () => {
    const res = await accountAgent
      .post('/api/events/batch')
      .send({ events: [{ event_key: 'soil_entry_saved' }] });
    expect(res.status).toBe(204);

    const rows = await eventRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(accountId);
    expect(rows[0].session_id).toBe(accountSessionId);
  });

  it('ignores session_id and user_id in the body', async () => {
    const res = await guestAgent.post('/api/events/batch').send({
      session_id: 'forged-session',
      user_id: accountId,
      events: [{ event_key: 'canvas_session', session_id: 'forged-session', user_id: accountId }],
    });
    expect(res.status).toBe(204);

    const rows = await eventRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBeNull();
    expect(rows[0].session_id).toBe(guestSessionId);
  });

  it('drops unknown keys and saves the known ones', async () => {
    const res = await guestAgent.post('/api/events/batch').send({
      events: [
        { event_key: 'not_a_real_key' },
        { event_key: 'harvest_entry_saved' },
        { event_key: 42 },
        null,
        { event_key: 'pdf_harvest_export' },
      ],
    });
    expect(res.status).toBe(204);
    expect((await eventRows()).map((r) => r.event_key)).toEqual(['harvest_entry_saved', 'pdf_harvest_export']);
  });

  it('returns 400 for more than 50 events', async () => {
    const events = Array.from({ length: 51 }, () => ({ event_key: 'canvas_session' }));
    const res = await guestAgent.post('/api/events/batch').send({ events });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Too many events' });
    expect(await eventRows()).toHaveLength(0);
  });

  it('returns 400 when events is not an array', async () => {
    const res = await guestAgent.post('/api/events/batch').send({ events: 'canvas_session' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'events must be an array' });

    const missing = await guestAgent.post('/api/events/batch').send({});
    expect(missing.status).toBe(400);
    expect(missing.body).toEqual({ error: 'events must be an array' });
  });

  it("stores a two-day-old timestamp as the server's now", async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const before = Date.now();
    const res = await guestAgent
      .post('/api/events/batch')
      .send({ events: [{ event_key: 'canvas_session', timestamp: twoDaysAgo }] });
    expect(res.status).toBe(204);

    const [row] = await eventRows();
    expect(Math.abs(row.created_at.getTime() - before)).toBeLessThan(5_000);
  });

  it('stores a ten-second-old timestamp as sent', async () => {
    const tenSecondsAgo = new Date(Date.now() - 10_000);
    const res = await guestAgent
      .post('/api/events/batch')
      .send({ events: [{ event_key: 'canvas_session', timestamp: tenSecondsAgo.toISOString() }] });
    expect(res.status).toBe(204);

    const [row] = await eventRows();
    expect(row.created_at.getTime()).toBe(tenSecondsAgo.getTime());
  });

  it('returns 204 and stores nothing when every key is unknown', async () => {
    const res = await guestAgent
      .post('/api/events/batch')
      .send({ events: [{ event_key: 'nope' }, { event_key: 'also_nope' }] });
    expect(res.status).toBe(204);
    expect(await eventRows()).toHaveLength(0);
  });
});

// ── Client/server key parity ────────────────────────────────────────────────

describe('client EVENT_KEYS', () => {
  it('matches the server list in order', () => {
    const source = readFileSync(
      path.resolve(__dirname, '../../client/src/lib/eventKeys.ts'),
      'utf8',
    );
    const block = source.match(/EVENT_KEYS\s*=\s*\[([\s\S]*?)\]\s*as const/);
    expect(block).not.toBeNull();
    const clientKeys = Array.from(block![1].matchAll(/'([^']+)'/g), (m) => m[1]);
    expect(clientKeys).toEqual(EVENT_KEYS.map((k) => k.key));
  });
});

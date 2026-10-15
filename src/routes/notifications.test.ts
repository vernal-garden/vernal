import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { Pool } from 'pg';
import app from '../index';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL must be set to run tests');

const pool = new Pool({ connectionString: url });

async function createUser(email: string): Promise<number> {
  const hash = await bcrypt.hash('Password123!', 4);
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO accounts (email, password_hash, zone, zone_location_label, email_verified)
     VALUES ($1, $2, '7b', 'Test City', true) RETURNING id`,
    [email, hash],
  );
  return rows[0].id;
}

async function loginAgent(email: string) {
  const agent = request.agent(app);
  await agent.post('/api/auth/guest');
  await agent.post('/api/auth/login').send({ email, password: 'Password123!' });
  return agent;
}

async function insertNotification(
  accountId: number,
  type: string,
  opts: { readAt?: boolean; minutesAgo?: number } = {},
): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO notifications (account_id, type, payload, read_at, created_at)
     VALUES ($1, $2, '{"seedId": 1}',
             CASE WHEN $3::boolean THEN now() ELSE NULL END,
             now() - make_interval(mins => $4))
     RETURNING id`,
    [accountId, type, opts.readAt ?? false, opts.minutesAgo ?? 0],
  );
  return rows[0].id;
}

let userId: number;
let otherId: number;
let agent: ReturnType<typeof request.agent>;

beforeAll(async () => {
  await pool.query(
    'TRUNCATE accounts, guest_sessions, password_reset_tokens, notifications RESTART IDENTITY CASCADE',
  );
  userId = await createUser('notif-user@example.com');
  otherId = await createUser('notif-other@example.com');
  agent = await loginAgent('notif-user@example.com');
});

afterAll(() => pool.end());

describe('/api/notifications', () => {
  it('returns 401 for a guest session', async () => {
    const guest = request.agent(app);
    await guest.post('/api/auth/guest');
    expect((await guest.get('/api/notifications')).status).toBe(401);
    expect((await guest.post('/api/notifications/read-all')).status).toBe(401);
    expect((await guest.patch('/api/notifications/1/read')).status).toBe(401);
  });

  it('lists unread first, then newest, and reports unreadCount', async () => {
    const oldUnread = await insertNotification(userId, 'contribution_approved', { minutesAgo: 60 });
    const newRead = await insertNotification(userId, 'contribution_rejected', {
      readAt: true,
      minutesAgo: 1,
    });
    const newUnread = await insertNotification(userId, 'contribution_approved', { minutesAgo: 5 });
    await insertNotification(otherId, 'contribution_approved');

    const res = await agent.get('/api/notifications');
    expect(res.status).toBe(200);
    expect(res.body.unreadCount).toBe(2);
    expect(res.body.data.map((n: { id: number }) => n.id)).toEqual([
      newUnread,
      oldUnread,
      newRead,
    ]);
    expect(res.body.data[0]).toEqual({
      id: newUnread,
      type: 'contribution_approved',
      payload: { seedId: 1 },
      readAt: null,
      createdAt: expect.any(String),
    });
    expect(res.body.data[2].readAt).not.toBeNull();
  });

  it('marks one notification read', async () => {
    const id = await insertNotification(userId, 'correction_applied');
    const res = await agent.patch(`/api/notifications/${id}/read`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(id);
    expect(res.body.readAt).not.toBeNull();
  });

  it('returns 400 for a non-numeric id and 404 for another account notification', async () => {
    expect((await agent.patch('/api/notifications/abc/read')).status).toBe(400);

    const theirs = await insertNotification(otherId, 'contribution_approved');
    expect((await agent.patch(`/api/notifications/${theirs}/read`)).status).toBe(404);
    const { rows } = await pool.query('SELECT read_at FROM notifications WHERE id = $1', [theirs]);
    expect(rows[0].read_at).toBeNull();
  });

  it('read-all clears unreadCount without touching other accounts', async () => {
    const res = await agent.post('/api/notifications/read-all');
    expect(res.status).toBe(200);
    expect(res.body.updated).toBeGreaterThanOrEqual(2);

    const list = await agent.get('/api/notifications');
    expect(list.body.unreadCount).toBe(0);

    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM notifications WHERE account_id = $1 AND read_at IS NULL',
      [otherId],
    );
    expect(rows[0].n).toBeGreaterThan(0);
  });
});

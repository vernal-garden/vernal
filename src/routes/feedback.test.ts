import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { Pool } from 'pg';
import app from '../index';
import * as mailer from '../lib/mailer';

vi.mock('../lib/mailer', () => ({ sendMail: vi.fn().mockResolvedValue(undefined) }));
const sendMailMock = vi.mocked(mailer.sendMail);

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL must be set to run tests');

const pool = new Pool({ connectionString: url });

async function resetDb() {
  await pool.query(
    'TRUNCATE accounts, guest_sessions, password_reset_tokens, feedback_submissions RESTART IDENTITY CASCADE',
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

async function getRow(id: number) {
  const { rows } = await pool.query(
    'SELECT user_id, category, message, source_surface, app_version, status FROM feedback_submissions WHERE id = $1',
    [id],
  );
  return rows[0];
}

const validBody = {
  category: 'bug',
  message: 'The canvas zoom jumps when I pinch.',
  sourceSurface: 'canvas',
  appVersion: '0.1.0',
};

async function guestAgent() {
  const agent = request.agent(app);
  await agent.post('/api/auth/guest');
  return agent;
}

const ORIGINAL_NOTIFY = process.env.FEEDBACK_NOTIFY_EMAIL;

beforeAll(resetDb);
afterAll(() => pool.end());

beforeEach(() => {
  sendMailMock.mockReset();
  sendMailMock.mockResolvedValue(undefined);
  delete process.env.FEEDBACK_NOTIFY_EMAIL;
});

afterEach(() => {
  if (ORIGINAL_NOTIFY === undefined) delete process.env.FEEDBACK_NOTIFY_EMAIL;
  else process.env.FEEDBACK_NOTIFY_EMAIL = ORIGINAL_NOTIFY;
});

describe('POST /api/feedback', () => {
  it('accepts a guest submission with user_id NULL', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/guest');

    const res = await agent.post('/api/feedback').send(validBody);

    expect(res.status).toBe(201);
    expect(typeof res.body.id).toBe('number');
    const row = await getRow(res.body.id);
    expect(row.user_id).toBeNull();
    expect(row.category).toBe('bug');
    expect(row.source_surface).toBe('canvas');
    expect(row.app_version).toBe('0.1.0');
    expect(row.status).toBe('new');
  });

  it('rejects a submission with no session cookie with 401', async () => {
    const res = await request(app).post('/api/feedback').send(validBody);
    expect(res.status).toBe(401);
  });

  it('records user_id for a signed-in submission', async () => {
    const accountId = await createUser('feedback-user@example.com');
    const agent = request.agent(app);
    await agent.post('/api/auth/guest');
    await agent.post('/api/auth/login').send({ email: 'feedback-user@example.com', password: 'Password123!' });

    const res = await agent.post('/api/feedback').send({ ...validBody, category: 'feature_request' });

    expect(res.status).toBe(201);
    const row = await getRow(res.body.id);
    expect(row.user_id).toBe(accountId);
    expect(row.category).toBe('feature_request');
  });

  it.each(['idea', 'data_quality', undefined])('rejects category %s with 400', async (category) => {
    const res = await (await guestAgent()).post('/api/feedback').send({ ...validBody, category });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid category.');
  });

  it('rejects a message under 10 characters after trimming', async () => {
    const res = await (await guestAgent())
      .post('/api/feedback')
      .send({ ...validBody, message: '   short    ' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Message must be between 10 and 5000 characters.');
  });

  it('rejects a message over 5000 characters', async () => {
    const res = await (await guestAgent())
      .post('/api/feedback')
      .send({ ...validBody, message: 'x'.repeat(5001) });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Message must be between 10 and 5000 characters.');
  });

  it('truncates sourceSurface and appVersion to 64 characters', async () => {
    const res = await (await guestAgent())
      .post('/api/feedback')
      .send({ ...validBody, sourceSurface: 's'.repeat(100), appVersion: 'v'.repeat(100) });
    expect(res.status).toBe(201);
    const row = await getRow(res.body.id);
    expect(row.source_surface).toHaveLength(64);
    expect(row.app_version).toHaveLength(64);
  });

  it('emails FEEDBACK_NOTIFY_EMAIL once with an escaped HTML body', async () => {
    process.env.FEEDBACK_NOTIFY_EMAIL = 'owner@example.test';

    const res = await (await guestAgent())
      .post('/api/feedback')
      .send({ ...validBody, message: '<script>alert(1)</script> broke' });

    expect(res.status).toBe(201);
    await vi.waitFor(() => expect(sendMailMock).toHaveBeenCalledTimes(1));
    const mail = sendMailMock.mock.calls[0][0];
    expect(mail.to).toBe('owner@example.test');
    expect(mail.subject).toBe('Vernal feedback: Bug — canvas');
    expect(mail.text).toContain('Guest (not logged in)');
    expect(mail.text).toContain(`Submission id: ${res.body.id}`);
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;');
  });

  it('still returns 201 and saves the row when sendMail rejects', async () => {
    process.env.FEEDBACK_NOTIFY_EMAIL = 'owner@example.test';
    sendMailMock.mockRejectedValue(new Error('SMTP down'));

    const res = await (await guestAgent()).post('/api/feedback').send(validBody);

    expect(res.status).toBe(201);
    await vi.waitFor(() => expect(sendMailMock).toHaveBeenCalledTimes(1));
    expect(await getRow(res.body.id)).toBeDefined();
  });

  it('does not send email when FEEDBACK_NOTIFY_EMAIL is unset', async () => {
    const res = await (await guestAgent()).post('/api/feedback').send(validBody);

    expect(res.status).toBe(201);
    await new Promise((r) => setTimeout(r, 50));
    expect(sendMailMock).not.toHaveBeenCalled();
  });
});

describe('feedback rate limits', () => {
  beforeEach(() => {
    process.env.ENFORCE_RATE_LIMITS = 'true';
  });
  afterEach(() => {
    delete process.env.ENFORCE_RATE_LIMITS;
  });

  it('allows 5 submissions per session per hour, then 429', async () => {
    // A different IP per request, so only the per-session limiter can produce the 429.
    const agent = request.agent(app);
    await agent.post('/api/auth/guest').set('X-Forwarded-For', '192.0.2.30');
    for (let i = 0; i < 5; i++) {
      const res = await agent.post('/api/feedback').set('X-Forwarded-For', `192.0.2.${50 + i}`).send(validBody);
      expect(res.status).toBe(201);
    }
    const blocked = await agent.post('/api/feedback').set('X-Forwarded-For', '192.0.2.55').send(validBody);
    expect(blocked.status).toBe(429);
  });

  it('caps one IP at 5 per hour across sessions', async () => {
    const ip = '192.0.2.31';
    const first = request.agent(app);
    await first.post('/api/auth/guest').set('X-Forwarded-For', ip);
    for (let i = 0; i < 5; i++) {
      expect((await first.post('/api/feedback').set('X-Forwarded-For', ip).send(validBody)).status).toBe(201);
    }
    const second = request.agent(app);
    await second.post('/api/auth/guest').set('X-Forwarded-For', ip);
    expect((await second.post('/api/feedback').set('X-Forwarded-For', ip).send(validBody)).status).toBe(429);
  });
});

describe('feedback email budget', () => {
  beforeEach(async () => {
    await pool.query('TRUNCATE feedback_submissions RESTART IDENTITY');
    process.env.FEEDBACK_NOTIFY_EMAIL = 'owner@example.test';
  });

  async function seedRecent(count: number) {
    await pool.query(
      `INSERT INTO feedback_submissions (category, message)
       SELECT 'general', 'Seeded feedback message' FROM generate_series(1, $1)`,
      [count],
    );
  }

  it('still emails when under the hourly budget', async () => {
    await seedRecent(19);
    const agent = request.agent(app);
    await agent.post('/api/auth/guest');
    const res = await agent.post('/api/feedback').send(validBody);
    expect(res.status).toBe(201);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
  });

  it('saves the submission but skips the email once the budget is used up', async () => {
    await seedRecent(20);
    const agent = request.agent(app);
    await agent.post('/api/auth/guest');
    const res = await agent.post('/api/feedback').send(validBody);
    expect(res.status).toBe(201);
    expect(await getRow(res.body.id)).toBeDefined();
    expect(sendMailMock).not.toHaveBeenCalled();
  });
});

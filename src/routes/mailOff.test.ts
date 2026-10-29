import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { Pool } from 'pg';
import app from '../index';
import { getServerConfig, setServerConfigForTests } from '../lib/serverConfig';
import { logger } from '../lib/logger';

// The real mailer is used on purpose: with mail off it must send nothing.

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL must be set to run tests');

const pool = new Pool({ connectionString: url });
const original = getServerConfig();
const PASSWORD = 'Password123!';
const OFF_ERROR = "Email isn't set up on this server.";

const TABLES =
  'accounts, guest_sessions, password_reset_tokens, email_verification_tokens, email_change_tokens, feedback_submissions, micro_feedback_responses';

async function createUser(email: string): Promise<number> {
  const hash = await bcrypt.hash(PASSWORD, 4);
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO accounts (email, password_hash, zone, zone_location_label, email_verified)
     VALUES ($1, $2, '7b', 'Test City', true)
     RETURNING id`,
    [email, hash],
  );
  return rows[0].id;
}

async function loginAgent(email: string) {
  const agent = request.agent(app);
  await agent.post('/api/auth/guest');
  await agent.post('/api/auth/login').send({ email, password: PASSWORD });
  return agent;
}

function mailOff() {
  setServerConfigForTests({ ...original, mail: 'off' });
}

beforeAll(() => pool.query(`TRUNCATE ${TABLES} RESTART IDENTITY CASCADE`));
beforeEach(() => pool.query(`TRUNCATE ${TABLES} RESTART IDENTITY CASCADE`));
afterEach(() => {
  setServerConfigForTests(original);
  vi.restoreAllMocks();
});
afterAll(() => pool.end());

describe('mail off: routes that exist to send email', () => {
  it('POST /api/auth/forgot-password -> 409, before validation and without touching the DB', async () => {
    mailOff();
    const email = 'forgot-off@example.com';
    await createUser(email);

    const res = await request(app).post('/api/auth/forgot-password').send({ email });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: OFF_ERROR });

    // Even a body that would otherwise fail validation gets the 409.
    const bad = await request(app).post('/api/auth/forgot-password').send({});
    expect(bad.status).toBe(409);

    const { rows } = await pool.query('SELECT 1 FROM password_reset_tokens');
    expect(rows).toHaveLength(0);
  });

  it('PATCH /api/me/email -> 409 before the password check, and no token is stored', async () => {
    const email = 'change-off@example.com';
    const id = await createUser(email);
    const agent = await loginAgent(email);
    mailOff();

    const res = await agent
      .patch('/api/me/email')
      .send({ newEmail: 'new-off@example.com', currentPassword: 'wrong-password' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: OFF_ERROR });

    const { rows } = await pool.query('SELECT 1 FROM email_change_tokens WHERE account_id = $1', [id]);
    expect(rows).toHaveLength(0);
  });

  it('POST /api/me/verify-email/resend -> 409 and no token is stored', async () => {
    const email = 'resend-off@example.com';
    const id = await createUser(email);
    await pool.query('UPDATE accounts SET email_verified = false WHERE id = $1', [id]);
    const agent = await loginAgent(email);
    mailOff();

    const res = await agent.post('/api/me/verify-email/resend');
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: OFF_ERROR });

    const { rows } = await pool.query('SELECT 1 FROM email_verification_tokens WHERE account_id = $1', [id]);
    expect(rows).toHaveLength(0);
  });

  it('keeps the login requirement ahead of the guard on /api/me routes', async () => {
    mailOff();
    const guest = request.agent(app);
    await guest.post('/api/auth/guest');
    expect((await guest.patch('/api/me/email').send({})).status).toBe(401);
    expect((await guest.post('/api/me/verify-email/resend')).status).toBe(401);
  });
});

describe('mail off: other flows', () => {
  it('registration creates the account, unverified, with no verification token', async () => {
    mailOff();
    const email = 'register-off@example.com';

    const res = await request(app).post('/api/auth/register').send({ email, password: PASSWORD });
    expect(res.status).toBe(201);
    const id = res.body.data.account.id as number;

    const account = await pool.query('SELECT email_verified FROM accounts WHERE id = $1', [id]);
    expect(account.rows[0].email_verified).toBe(false);
    const tokens = await pool.query('SELECT 1 FROM email_verification_tokens WHERE account_id = $1', [id]);
    expect(tokens.rows).toHaveLength(0);
  });

  it('PATCH /api/me/password still works and the notice is skipped without logging the address', async () => {
    const email = 'password-off@example.com';
    await createUser(email);
    const agent = await loginAgent(email);
    mailOff();
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});

    const res = await agent
      .patch('/api/me/password')
      .send({ currentPassword: PASSWORD, newPassword: 'NewPassword456!' });
    expect(res.status).toBe(200);

    // The notice is sent without being awaited, so give it a tick.
    await new Promise((r) => setTimeout(r, 50));
    expect(info).toHaveBeenCalledWith('mail off: message skipped');
    expect(JSON.stringify(info.mock.calls)).not.toContain('password-off');
  });

  it('feedback is stored even though the notification is skipped', async () => {
    mailOff();
    const original_notify = process.env.FEEDBACK_NOTIFY_EMAIL;
    process.env.FEEDBACK_NOTIFY_EMAIL = 'owner@example.com';
    try {
      const agent = request.agent(app);
      await agent.post('/api/auth/guest');
      const res = await agent.post('/api/feedback').send({
        category: 'bug',
        message: 'Stored with mail off.',
        sourceSurface: 'canvas',
        appVersion: '0.1.0',
      });
      expect(res.status).toBe(201);
      const { rows } = await pool.query('SELECT message FROM feedback_submissions WHERE id = $1', [res.body.id]);
      expect(rows[0].message).toBe('Stored with mail off.');
    } finally {
      if (original_notify === undefined) delete process.env.FEEDBACK_NOTIFY_EMAIL;
      else process.env.FEEDBACK_NOTIFY_EMAIL = original_notify;
    }
  });

  it('micro-feedback is stored even though the notification is skipped', async () => {
    const email = 'micro-off@example.com';
    await createUser(email);
    const agent = await loginAgent(email);
    mailOff();
    const original_notify = process.env.FEEDBACK_NOTIFY_EMAIL;
    process.env.FEEDBACK_NOTIFY_EMAIL = 'owner@example.com';
    try {
      expect((await agent.post('/api/micro-feedback/shown').send({ triggerKey: 'planted' })).status).toBe(200);
      const res = await agent.post('/api/micro-feedback').send({ triggerKey: 'planted', response: 'thumbs_up' });
      expect(res.status).toBe(201);
      const { rows } = await pool.query('SELECT response FROM micro_feedback_responses WHERE id = $1', [res.body.id]);
      expect(rows[0].response).toBe('thumbs_up');
    } finally {
      if (original_notify === undefined) delete process.env.FEEDBACK_NOTIFY_EMAIL;
      else process.env.FEEDBACK_NOTIFY_EMAIL = original_notify;
    }
  });
});

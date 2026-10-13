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

type Agent = ReturnType<typeof request.agent>;

async function resetDb() {
  await pool.query(
    'TRUNCATE accounts, guest_sessions, password_reset_tokens, micro_feedback_responses RESTART IDENTITY CASCADE',
  );
}

async function createUser(
  email: string,
  role: 'user' | 'admin' = 'user',
  password = 'Password123!',
): Promise<number> {
  const hash = await bcrypt.hash(password, 4);
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO accounts (email, password_hash, zone, zone_location_label, email_verified, role)
     VALUES ($1, $2, '7b', 'Test City', true, $3)
     RETURNING id`,
    [email, hash, role],
  );
  return rows[0].id;
}

async function loginAgent(email: string, password = 'Password123!'): Promise<Agent> {
  const agent = request.agent(app);
  await agent.post('/api/auth/guest');
  await agent.post('/api/auth/login').send({ email, password });
  return agent;
}

async function flag(accountId: number, column: string): Promise<boolean> {
  const { rows } = await pool.query(`SELECT ${column} AS v FROM accounts WHERE id = $1`, [
    accountId,
  ]);
  return rows[0].v;
}

async function responseText(id: number): Promise<string> {
  const { rows } = await pool.query('SELECT response FROM micro_feedback_responses WHERE id = $1', [
    id,
  ]);
  return rows[0].response;
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

// ── Access ────────────────────────────────────────────────────────────────────

describe('Access', () => {
  it('guest → 401 on every route', async () => {
    const guest = request.agent(app);
    await guest.post('/api/auth/guest');

    expect(
      (await guest.post('/api/micro-feedback/shown').send({ triggerKey: 'planted' })).status,
    ).toBe(401);
    expect(
      (await guest.post('/api/micro-feedback').send({ triggerKey: 'planted', response: 'thumbs_up' }))
        .status,
    ).toBe(401);
    expect((await guest.patch('/api/micro-feedback/1').send({ comment: 'hi' })).status).toBe(401);
  });
});

// ── POST /shown ───────────────────────────────────────────────────────────────

describe('POST /api/micro-feedback/shown', () => {
  let accountId: number;
  let me: Agent;

  beforeAll(async () => {
    accountId = await createUser('mf-shown@example.com');
    me = await loginAgent('mf-shown@example.com');
  });

  it('shows the prompt once, then sets the flag', async () => {
    expect(await flag(accountId, 'mf_first_sowing')).toBe(false);

    const first = await me.post('/api/micro-feedback/shown').send({ triggerKey: 'first_sowing' });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ show: true });
    expect(await flag(accountId, 'mf_first_sowing')).toBe(true);

    const second = await me.post('/api/micro-feedback/shown').send({ triggerKey: 'first_sowing' });
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ show: false });
  });

  it('400 for an unknown key, and for the retired viewed_seed', async () => {
    const unknown = await me.post('/api/micro-feedback/shown').send({ triggerKey: 'nope' });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toBe('Unknown trigger.');

    const retired = await me.post('/api/micro-feedback/shown').send({ triggerKey: 'viewed_seed' });
    expect(retired.status).toBe(400);
    expect(await flag(accountId, 'mf_viewed_seed')).toBe(false);

    expect((await me.post('/api/micro-feedback/shown').send({})).status).toBe(400);
  });
});

// ── POST / and PATCH /:id ─────────────────────────────────────────────────────

describe('Answers and comments', () => {
  let me: Agent;
  let other: Agent;
  let thumbsId: number;
  let upgradeId: number;

  beforeAll(async () => {
    await createUser('mf-answer@example.com');
    await createUser('mf-other@example.com');
    me = await loginAgent('mf-answer@example.com');
    other = await loginAgent('mf-other@example.com');
  });

  it('409 when the prompt was never shown', async () => {
    const res = await me
      .post('/api/micro-feedback')
      .send({ triggerKey: 'planted', response: 'thumbs_up' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Prompt not shown.');
  });

  it('saves a thumbs answer once', async () => {
    await me.post('/api/micro-feedback/shown').send({ triggerKey: 'planted' });

    const bad = await me
      .post('/api/micro-feedback')
      .send({ triggerKey: 'planted', response: 'thumbs_sideways' });
    expect(bad.status).toBe(400);

    const res = await me
      .post('/api/micro-feedback')
      .send({ triggerKey: 'planted', response: 'thumbs_up' });
    expect(res.status).toBe(201);
    expect(typeof res.body.id).toBe('number');
    thumbsId = res.body.id;
    expect(await responseText(thumbsId)).toBe('thumbs_up');

    const again = await me
      .post('/api/micro-feedback')
      .send({ triggerKey: 'planted', response: 'thumbs_down' });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('Already answered.');
  });

  it('saves upgrade text; empty text → 400', async () => {
    await me.post('/api/micro-feedback/shown').send({ triggerKey: 'upgrade' });

    const empty = await me
      .post('/api/micro-feedback')
      .send({ triggerKey: 'upgrade', response: '   ' });
    expect(empty.status).toBe(400);

    const res = await me
      .post('/api/micro-feedback')
      .send({ triggerKey: 'upgrade', response: '  The harvest log.  ' });
    expect(res.status).toBe(201);
    upgradeId = res.body.id;
    expect(await responseText(upgradeId)).toBe('The harvest log.');
  });

  it('PATCH adds a comment once', async () => {
    const res = await me.patch(`/api/micro-feedback/${thumbsId}`).send({ comment: ' nice ' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: thumbsId });
    expect(await responseText(thumbsId)).toBe('thumbs_up\n\nnice');

    const again = await me.patch(`/api/micro-feedback/${thumbsId}`).send({ comment: 'more' });
    expect(again.status).toBe(409);
    expect(await responseText(thumbsId)).toBe('thumbs_up\n\nnice');
  });

  it('PATCH: another account → 404, upgrade row → 400, bad id → 400', async () => {
    expect((await other.patch(`/api/micro-feedback/${thumbsId}`).send({ comment: 'x' })).status).toBe(
      404,
    );

    const upgrade = await me.patch(`/api/micro-feedback/${upgradeId}`).send({ comment: 'x' });
    expect(upgrade.status).toBe(400);
    expect(upgrade.body.error).toBe('Comments are for thumbs prompts.');

    expect((await me.patch('/api/micro-feedback/abc').send({ comment: 'x' })).status).toBe(400);
  });

  it('PATCH: an empty comment → 400', async () => {
    await other.post('/api/micro-feedback/shown').send({ triggerKey: 'planted' });
    const { body } = await other
      .post('/api/micro-feedback')
      .send({ triggerKey: 'planted', response: 'thumbs_down' });
    const res = await other.patch(`/api/micro-feedback/${body.id}`).send({ comment: '' });
    expect(res.status).toBe(400);
  });
});

// ── Email ─────────────────────────────────────────────────────────────────────

describe('Notification email', () => {
  let me: Agent;

  beforeAll(async () => {
    await createUser('mf-email@example.com');
    me = await loginAgent('mf-email@example.com');
  });

  it('sends when FEEDBACK_NOTIFY_EMAIL is set, escaping user text', async () => {
    process.env.FEEDBACK_NOTIFY_EMAIL = 'team@example.com';
    await me.post('/api/micro-feedback/shown').send({ triggerKey: 'upgrade' });

    const res = await me
      .post('/api/micro-feedback')
      .send({ triggerKey: 'upgrade', response: '<b>photos</b>' });
    expect(res.status).toBe(201);

    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const mail = sendMailMock.mock.calls[0][0];
    expect(mail.to).toBe('team@example.com');
    expect(mail.subject).toBe('Vernal micro-feedback: upgrade');
    expect(mail.text).toContain('<b>photos</b>');
    expect(mail.text).toContain('mf-email@example.com');
    expect(mail.html).toContain('&lt;b&gt;photos&lt;/b&gt;');
    expect(mail.html).not.toContain('<b>photos</b>');
  });

  it('a rejecting sendMail still returns 201', async () => {
    process.env.FEEDBACK_NOTIFY_EMAIL = 'team@example.com';
    sendMailMock.mockRejectedValue(new Error('SMTP down'));
    await me.post('/api/micro-feedback/shown').send({ triggerKey: 'cross_season' });

    const res = await me
      .post('/api/micro-feedback')
      .send({ triggerKey: 'cross_season', response: 'thumbs_up' });
    expect(res.status).toBe(201);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
  });

  it('does not send when FEEDBACK_NOTIFY_EMAIL is unset', async () => {
    await me.post('/api/micro-feedback/shown').send({ triggerKey: 'planted' });
    const res = await me
      .post('/api/micro-feedback')
      .send({ triggerKey: 'planted', response: 'thumbs_up' });
    expect(res.status).toBe(201);
    expect(sendMailMock).not.toHaveBeenCalled();
  });
});

// ── Admin features ────────────────────────────────────────────────────────────

describe('GET /api/admin/features', () => {
  it('counts the flag and the response for harvest_logged', async () => {
    await resetDb();
    await createUser('mf-admin@example.com', 'admin');
    await createUser('mf-features@example.com');
    const admin = await loginAgent('mf-admin@example.com');
    const me = await loginAgent('mf-features@example.com');

    await me.post('/api/micro-feedback/shown').send({ triggerKey: 'harvest_logged' });
    await me
      .post('/api/micro-feedback')
      .send({ triggerKey: 'harvest_logged', response: 'thumbs_up' });

    const res = await admin.get('/api/admin/features');
    expect(res.status).toBe(200);
    const row = res.body.microFeedback.find(
      (m: { triggerKey: string }) => m.triggerKey === 'harvest_logged',
    );
    expect(row.timesFired).toBe(1);
    expect(row.responses).toBe(1);
    expect(row.responseRate).toBe(1);
  });
});

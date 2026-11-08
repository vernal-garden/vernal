import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { Pool } from 'pg';
import app from '../index';
import { BETA_TERMS_VERSION } from '../lib/legal';
import { BETA_TERMS_ERROR } from '../middleware/betaTerms';
import { PENDING_DELETION_ERROR } from '../middleware/pendingDeletion';

// The job runs in the background and would outlive the test's account.
vi.mock('../lib/exportWorker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/exportWorker')>()),
  processExportJob: vi.fn().mockResolvedValue(undefined),
}));

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL must be set to run tests');

const pool = new Pool({ connectionString: url });
const PASSWORD = 'Password123!';
const email = 'terms@example.com';

async function createUser(opts: { participant?: boolean; version?: string | null; deletionScheduled?: boolean } = {}) {
  const { participant = true, version = null, deletionScheduled = false } = opts;
  const hash = await bcrypt.hash(PASSWORD, 4);
  await pool.query(
    `INSERT INTO accounts
       (email, password_hash, zone, zone_location_label, email_verified,
        beta_participant_at, beta_terms_version, deletion_scheduled_at)
     VALUES ($1, $2, '7b', 'Test City', true, $3, $4, $5)`,
    [email, hash, participant ? new Date() : null, version, deletionScheduled ? new Date() : null],
  );
}

async function loginAgent() {
  const agent = request.agent(app);
  await agent.post('/api/auth/guest');
  const res = await agent.post('/api/auth/login').send({ email, password: PASSWORD });
  expect(res.status).toBe(200);
  return agent;
}

async function termsRow() {
  const { rows } = await pool.query(
    'SELECT beta_terms_version, beta_terms_accepted_at FROM accounts WHERE email = $1',
    [email],
  );
  return rows[0] as { beta_terms_version: string | null; beta_terms_accepted_at: Date | null };
}

beforeEach(async () => {
  await pool.query('TRUNCATE accounts, guest_sessions, password_reset_tokens RESTART IDENTITY CASCADE');
});

afterAll(async () => {
  await pool.end();
});

describe('beta terms gate through the app', () => {
  it('refuses a pending participant everywhere but the allowlist', async () => {
    await createUser();
    const agent = await loginAgent();

    const gardens = await agent.get('/api/gardens');
    expect(gardens.status).toBe(403);
    expect(gardens.body).toEqual(BETA_TERMS_ERROR);
    expect((await agent.get('/api/me')).status).toBe(403);
    expect((await agent.post('/api/gardens').send({})).status).toBe(403);

    expect((await agent.get('/api/config')).status).toBe(200);
    const session = await agent.get('/api/auth/session');
    expect(session.status).toBe(200);
    expect(session.body.data.account.betaTermsRequired).toBe(true);
  });

  it('only allows GET on /api/config', async () => {
    await createUser();
    const agent = await loginAgent();
    expect((await agent.post('/api/config')).status).toBe(403);
  });

  it('is case- and trailing-slash-insensitive, as the deletion gate is', async () => {
    await createUser();
    const agent = await loginAgent();
    expect((await agent.get('/API/Config/')).status).toBe(200);
    expect((await agent.get('/api/Gardens/')).status).toBe(403);
  });

  it('allows everything after accepting, and accepting twice is fine', async () => {
    await createUser();
    const agent = await loginAgent();
    expect((await agent.get('/api/gardens')).status).toBe(403);

    const accept = await agent.post('/api/me/beta-terms').send({ accept: true });
    expect(accept.status).toBe(204);
    const row = await termsRow();
    expect(row.beta_terms_version).toBe(BETA_TERMS_VERSION);
    expect(row.beta_terms_accepted_at).not.toBeNull();

    expect((await agent.get('/api/gardens')).status).toBe(200);
    expect((await agent.get('/api/me')).status).toBe(200);
    const session = await agent.get('/api/auth/session');
    expect(session.body.data.account.betaTermsRequired).toBe(false);

    expect((await agent.post('/api/me/beta-terms').send({ accept: true })).status).toBe(204);
    expect((await termsRow()).beta_terms_accepted_at).toEqual(row.beta_terms_accepted_at);
    expect((await agent.get('/api/gardens')).status).toBe(200);
  });

  it.each([
    ['no body', undefined],
    ['an empty body', {}],
    ['accept false', { accept: false }],
    ['accept as a string', { accept: 'true' }],
    ['accept as 1', { accept: 1 }],
  ])('rejects acceptance with %s', async (_label, body) => {
    await createUser();
    const agent = await loginAgent();
    const res = await agent.post('/api/me/beta-terms').send(body);
    expect(res.status).toBe(400);
    expect((await termsRow()).beta_terms_version).toBeNull();
    expect((await agent.get('/api/gardens')).status).toBe(403);
  });

  it('requires an account: a guest cannot accept', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/guest');
    const res = await agent.post('/api/me/beta-terms').send({ accept: true });
    expect(res.status).toBe(401);
  });

  it('never refuses a non-participant', async () => {
    await createUser({ participant: false });
    const agent = await loginAgent();
    expect((await agent.get('/api/gardens')).status).toBe(200);
    expect((await agent.get('/api/me')).status).toBe(200);
  });

  it('never refuses a participant who accepted the current version', async () => {
    await createUser({ version: BETA_TERMS_VERSION });
    const agent = await loginAgent();
    expect((await agent.get('/api/gardens')).status).toBe(200);
  });

  it('refuses a participant who accepted an older version', async () => {
    await createUser({ version: '2000-01-01' });
    const agent = await loginAgent();
    expect((await agent.get('/api/gardens')).status).toBe(403);
  });

  it('lets a pending participant delete the account', async () => {
    await createUser();
    const agent = await loginAgent();
    const res = await agent.delete('/api/me');
    expect(res.status).toBe(204);
    const { rows } = await pool.query('SELECT deletion_scheduled_at FROM accounts WHERE email = $1', [email]);
    expect(rows[0].deletion_scheduled_at).not.toBeNull();
    const sessions = await pool.query('SELECT 1 FROM guest_sessions');
    expect(sessions.rows).toHaveLength(0);
  });

  it('lets a pending participant sign out', async () => {
    await createUser();
    const agent = await loginAgent();
    const res = await agent.delete('/api/auth/session');
    expect(res.status).toBe(200);
    expect((await agent.get('/api/gardens')).status).toBe(401);
  });

  it('lets a pending participant request an export and read its status', async () => {
    await createUser();
    const agent = await loginAgent();

    const requested = await agent.post('/api/me/export');
    expect(requested.status).toBe(202);

    const status = await agent.get('/api/me/export');
    expect(status.status).toBe(200);
    expect(status.body.data.jobId).toBe(requested.body.data.jobId);
    expect(status.body.data.status).toBe('pending');
  });

  it('lets a pending participant read the subscription but not start a checkout', async () => {
    await createUser();
    const agent = await loginAgent();

    const subscription = await agent.get('/api/subscription');
    expect(subscription.status).toBe(200);
    expect(subscription.body.tier).toBeDefined();

    const checkout = await agent.post('/api/subscription/checkout').send({ interval: 'monthly' });
    expect(checkout.status).toBe(403);
    expect(checkout.body).toEqual(BETA_TERMS_ERROR);
  });

  describe('with a scheduled deletion', () => {
    it('runs after the deletion gate: a blocked write gets the 409, not the 403', async () => {
      await createUser({ deletionScheduled: true });
      const agent = await loginAgent();
      const write = await agent.post('/api/gardens').send({});
      expect(write.status).toBe(409);
      expect(write.body).toEqual(PENDING_DELETION_ERROR);
      // A read passes the deletion gate and is then held by the terms gate.
      const read = await agent.get('/api/gardens');
      expect(read.status).toBe(403);
      expect(read.body).toEqual(BETA_TERMS_ERROR);
    });

    it('accepting the terms, then cancelling the deletion, works', async () => {
      await createUser({ deletionScheduled: true });
      const agent = await loginAgent();

      expect((await agent.post('/api/me/beta-terms').send({ accept: true })).status).toBe(204);

      const cancel = await agent.post('/api/me/cancel-deletion');
      expect(cancel.status).toBe(200);
      expect(cancel.body.data.deletionScheduledAt).toBeNull();
      expect((await agent.get('/api/gardens')).status).toBe(200);
    });

    it('cancelling the deletion needs no acceptance, and leaves the participant held', async () => {
      await createUser({ deletionScheduled: true });
      const agent = await loginAgent();

      const cancel = await agent.post('/api/me/cancel-deletion');
      expect(cancel.status).toBe(200);
      expect(cancel.body.data.deletionScheduledAt).toBeNull();
      const { rows } = await pool.query('SELECT deletion_scheduled_at FROM accounts WHERE email = $1', [email]);
      expect(rows[0].deletion_scheduled_at).toBeNull();
      expect((await termsRow()).beta_terms_version).toBeNull();

      const gardens = await agent.get('/api/gardens');
      expect(gardens.status).toBe(403);
      expect(gardens.body).toEqual(BETA_TERMS_ERROR);
    });

    it('the billing portal gets the 409, not the 403', async () => {
      await createUser({ deletionScheduled: true });
      const agent = await loginAgent();
      const portal = await agent.post('/api/subscription/portal');
      expect(portal.status).toBe(409);
      expect(portal.body).toEqual(PENDING_DELETION_ERROR);
    });
  });
});

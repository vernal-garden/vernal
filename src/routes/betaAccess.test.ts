import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { Pool } from 'pg';
import app from '../index';
import { invalidateBetaSettings } from '../lib/beta';
import { BETA_TERMS_VERSION } from '../lib/legal';
import { getServerConfig, setServerConfigForTests } from '../lib/serverConfig';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL must be set to run tests');

const pool = new Pool({ connectionString: url });
const original = getServerConfig();

async function resetBeta() {
  await pool.query('DELETE FROM beta_invites');
  await pool.query(
    `UPDATE beta_settings
        SET gate_on = false, guest_mode_on = true, supporter_access_on = true,
            gate_first_on_at = NULL
      WHERE id = 1`,
  );
  invalidateBetaSettings();
}

async function setSupporterAccess(on: boolean) {
  await pool.query('UPDATE beta_settings SET supporter_access_on = $1 WHERE id = 1', [on]);
  invalidateBetaSettings();
}

// Fixtures set beta_terms_version so the terms gate never interferes.
async function createUser(
  email: string,
  { participant = false, tier = 'free' }: { participant?: boolean; tier?: 'free' | 'supporter' } = {},
) {
  const hash = await bcrypt.hash('Password123!', 4);
  await pool.query(
    `INSERT INTO accounts
       (email, password_hash, zone, zone_location_label, email_verified, subscription_tier,
        beta_participant_at, beta_terms_version)
     VALUES ($1, $2, '7b', 'Test City', true, $3, $4, $5)`,
    [email, hash, tier, participant ? new Date() : null, participant ? BETA_TERMS_VERSION : null],
  );
}

async function loginAgent(email: string) {
  const agent = request.agent(app);
  await agent.post('/api/auth/guest');
  const res = await agent.post('/api/auth/login').send({ email, password: 'Password123!' });
  return { agent, login: res };
}

async function storedTier(email: string) {
  const { rows } = await pool.query('SELECT subscription_tier FROM accounts WHERE email = $1', [email]);
  return rows[0].subscription_tier as string;
}

beforeAll(async () => {
  setServerConfigForTests({ ...original, billing: 'stripe' });
});
beforeEach(async () => {
  await pool.query('TRUNCATE accounts, guest_sessions, password_reset_tokens RESTART IDENTITY CASCADE');
});
afterEach(async () => {
  setServerConfigForTests({ ...original, billing: 'stripe' });
  await resetBeta();
});
afterAll(async () => {
  setServerConfigForTests(original);
  await pool.end();
});

// A requireSupporter route on a real row the agent's account owns: 200 passes, 402 is refused.
async function supporterRoute(agent: request.Agent, email: string) {
  const garden = await agent.post('/api/gardens').send({
    name: 'Beta Garden', style: 'grid', zone: '7b', growingMethod: 'in_ground',
  });
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO amendment_logs (user_id, garden_id, application_date, product_name, amendment_type)
     SELECT id, $2, '2026-05-01', 'Lime', 'lime' FROM accounts WHERE email = $1
     RETURNING id::text`,
    [email, String(garden.body.id)],
  );
  return agent.patch(`/api/amendments/${rows[0].id}`).send({ productName: 'Changed' });
}

describe('beta participant, switch on', () => {
  beforeEach(() => createUser('p@example.com', { participant: true }));

  it('passes requireSupporter and reads supporter everywhere, stored tier stays free', async () => {
    const { agent, login } = await loginAgent('p@example.com');
    expect(login.body.data.account.subscriptionTier).toBe('supporter');
    expect((await supporterRoute(agent, 'p@example.com')).status).toBe(200);
    const session = await agent.get('/api/auth/session');
    expect(session.body.data.account.subscriptionTier).toBe('supporter');
    expect(session.body.data.account.betaParticipant).toBe(true);
    expect(session.body.data.account.betaTermsRequired).toBe(false);
    expect((await agent.get('/api/me')).body.data.subscriptionTier).toBe('supporter');
    expect(await storedTier('p@example.com')).toBe('free');
  });

  it('GET /api/subscription leaves tier alone and reports betaAccess', async () => {
    const { agent } = await loginAgent('p@example.com');
    const res = await agent.get('/api/subscription');
    expect(res.body.tier).toBe('free');
    expect(res.body.isSupporter).toBe(false);
    expect(res.body.betaAccess).toBe(true);
  });

  it('betaAccess is false when the participant already pays', async () => {
    await createUser('paid@example.com', { participant: true, tier: 'supporter' });
    const { agent } = await loginAgent('paid@example.com');
    const res = await agent.get('/api/subscription');
    expect(res.body.tier).toBe('supporter');
    expect(res.body.betaAccess).toBe(false);
  });

  it('a participant with unaccepted terms is flagged on the session', async () => {
    await pool.query("UPDATE accounts SET beta_terms_version = NULL WHERE email = 'p@example.com'");
    const { agent } = await loginAgent('p@example.com');
    const session = await agent.get('/api/auth/session');
    expect(session.body.data.account.betaTermsRequired).toBe(true);
  });
});

describe('beta participant, switch off', () => {
  beforeEach(async () => {
    await createUser('p@example.com', { participant: true });
    await setSupporterAccess(false);
  });

  it('is free: 402 and free tier', async () => {
    const { agent, login } = await loginAgent('p@example.com');
    expect(login.body.data.account.subscriptionTier).toBe('free');
    expect((await supporterRoute(agent, 'p@example.com')).status).toBe(402);
    expect((await agent.get('/api/auth/session')).body.data.account.subscriptionTier).toBe('free');
    expect((await agent.get('/api/me')).body.data.subscriptionTier).toBe('free');
    const sub = await agent.get('/api/subscription');
    expect(sub.body.betaAccess).toBe(false);
  });
});

describe('non-participant', () => {
  beforeEach(() => createUser('n@example.com'));

  it.each([true, false])('is unaffected with the switch %s', async (on) => {
    await setSupporterAccess(on);
    const { agent, login } = await loginAgent('n@example.com');
    expect(login.body.data.account.subscriptionTier).toBe('free');
    expect((await supporterRoute(agent, 'n@example.com')).status).toBe(402);
    expect((await agent.get('/api/auth/session')).body.data.account.subscriptionTier).toBe('free');
    expect((await agent.get('/api/me')).body.data.subscriptionTier).toBe('free');
    const sub = await agent.get('/api/subscription');
    expect(sub.body.tier).toBe('free');
    expect(sub.body.betaAccess).toBe(false);
  });
});

describe('billing off', () => {
  it('every account is supporter whatever the beta state', async () => {
    setServerConfigForTests({ ...original, billing: 'off' });
    await createUser('p@example.com', { participant: true });
    await createUser('n@example.com');
    await setSupporterAccess(false);
    for (const email of ['p@example.com', 'n@example.com']) {
      const { agent, login } = await loginAgent(email);
      expect(login.body.data.account.subscriptionTier).toBe('supporter');
      expect((await agent.get('/api/auth/session')).body.data.account.subscriptionTier).toBe('supporter');
      expect((await agent.get('/api/me')).body.data.subscriptionTier).toBe('supporter');
    }
  });
});

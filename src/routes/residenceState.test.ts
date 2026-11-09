import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { Pool } from 'pg';
import app from '../index';
import { BETA_TERMS_VERSION } from '../lib/legal';
import { US_STATE_CODES } from '../lib/beta';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL must be set to run tests');

const pool = new Pool({ connectionString: url });
const PASSWORD = 'Password123!';
const email = 'state@example.com';

// A participant has accepted the current beta terms, so the terms gate lets them through.
async function createUser(opts: { participant: boolean }): Promise<number> {
  const hash = await bcrypt.hash(PASSWORD, 4);
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO accounts
       (email, password_hash, zone, zone_location_label, email_verified,
        beta_participant_at, beta_terms_version, beta_terms_accepted_at)
     VALUES ($1, $2, '7b', 'Test City', true, $3, $4, $5)
     RETURNING id`,
    [
      email,
      hash,
      opts.participant ? new Date() : null,
      opts.participant ? BETA_TERMS_VERSION : null,
      opts.participant ? new Date() : null,
    ],
  );
  return rows[0].id;
}

async function loginAgent() {
  const agent = request.agent(app);
  await agent.post('/api/auth/guest');
  const res = await agent.post('/api/auth/login').send({ email, password: PASSWORD });
  expect(res.status).toBe(200);
  return agent;
}

async function stateRow(id: number) {
  const { rows } = await pool.query<{
    residence_state: string | null;
    residence_state_confirmed_at: Date | null;
  }>('SELECT residence_state, residence_state_confirmed_at FROM accounts WHERE id = $1', [id]);
  return rows[0];
}

beforeEach(async () => {
  await pool.query('TRUNCATE accounts, guest_sessions, password_reset_tokens RESTART IDENTITY CASCADE');
});

afterAll(async () => {
  await pool.end();
});

describe('US_STATE_CODES', () => {
  it('is the 50 states, without DC', () => {
    expect(US_STATE_CODES).toHaveLength(50);
    expect(new Set(US_STATE_CODES).size).toBe(50);
    expect(US_STATE_CODES).not.toContain('DC');
    expect(US_STATE_CODES).not.toContain('PR');
  });
});

describe('PUT /api/me/residence-state', () => {
  it('a participant sets their state and GET /api/me returns it', async () => {
    const id = await createUser({ participant: true });
    const agent = await loginAgent();

    const before = await agent.get('/api/me');
    expect(before.body.data.residenceState).toBeNull();
    expect(before.body.data.residenceStateConfirmedAt).toBeNull();

    const res = await agent.put('/api/me/residence-state').send({ state: 'WA' });
    expect(res.status).toBe(204);
    const row = await stateRow(id);
    expect(row.residence_state).toBe('WA');
    expect(row.residence_state_confirmed_at).not.toBeNull();

    const me = await agent.get('/api/me');
    expect(me.body.data.residenceState).toBe('WA');
    expect(new Date(me.body.data.residenceStateConfirmedAt).getTime()).toBe(
      row.residence_state_confirmed_at!.getTime(),
    );
  });

  it('a later call replaces the state and moves the confirmed time', async () => {
    const id = await createUser({ participant: true });
    const agent = await loginAgent();

    await agent.put('/api/me/residence-state').send({ state: 'WA' });
    // Backdate the first confirmation so the move is visible.
    await pool.query(
      `UPDATE accounts SET residence_state_confirmed_at = now() - interval '1 day' WHERE id = $1`,
      [id],
    );
    const first = await stateRow(id);

    const res = await agent.put('/api/me/residence-state').send({ state: 'OUTSIDE_US' });
    expect(res.status).toBe(204);
    const second = await stateRow(id);
    expect(second.residence_state).toBe('OUTSIDE_US');
    expect(second.residence_state_confirmed_at!.getTime()).toBeGreaterThan(
      first.residence_state_confirmed_at!.getTime(),
    );

    const me = await agent.get('/api/me');
    expect(me.body.data.residenceState).toBe('OUTSIDE_US');
  });

  it.each([['DC'], ['XX'], ['wa'], [''], [' WA'], ['outside_us']])(
    'refuses %j with 400 and stores nothing',
    async (state) => {
      const id = await createUser({ participant: true });
      const agent = await loginAgent();
      const res = await agent.put('/api/me/residence-state').send({ state });
      expect(res.status).toBe(400);
      expect(res.body.error).toEqual(expect.any(String));
      expect(await stateRow(id)).toEqual({ residence_state: null, residence_state_confirmed_at: null });
    },
  );

  it('refuses a missing or non-string state with 400', async () => {
    await createUser({ participant: true });
    const agent = await loginAgent();
    for (const body of [{}, { state: 12 }, { state: ['WA'] }, { state: null }]) {
      const res = await agent.put('/api/me/residence-state').send(body);
      expect(res.status).toBe(400);
    }
  });

  it('refuses a non-participant with 403 and stores nothing', async () => {
    const id = await createUser({ participant: false });
    const agent = await loginAgent();
    const res = await agent.put('/api/me/residence-state').send({ state: 'WA' });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Only beta testers can set this.' });
    expect((await stateRow(id)).residence_state).toBeNull();
  });

  it("GET /api/me returns null for a non-participant, even with a stored value", async () => {
    const id = await createUser({ participant: false });
    await pool.query(
      `UPDATE accounts SET residence_state = 'WA', residence_state_confirmed_at = now() WHERE id = $1`,
      [id],
    );
    const agent = await loginAgent();
    const me = await agent.get('/api/me');
    expect(me.status).toBe(200);
    expect(me.body.data.residenceState).toBeNull();
    expect(me.body.data.residenceStateConfirmedAt).toBeNull();
  });

  it('requires an account (401 for a guest)', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/guest');
    const res = await agent.put('/api/me/residence-state').send({ state: 'WA' });
    expect(res.status).toBe(401);
  });
});

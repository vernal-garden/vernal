import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { Pool } from 'pg';
import app from '../index';
import { getServerConfig, setServerConfigForTests, type ServerConfig } from '../lib/serverConfig';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL must be set to run tests');

const pool = new Pool({ connectionString: url });

// The window used throughout: participants join on PARTICIPANT_AT, the beta
// ends at ENDS_AT, and IN_WINDOW lies between them.
const ENDS_AT = '2026-12-01T08:00:00.000Z';
const PARTICIPANT_AT = '2026-10-01T00:00:00.000Z';
const IN_WINDOW = '2026-10-15T12:00:00.000Z';

const LIFETIME = '/api/admin/beta/lifetime';

async function createUser(email: string, role: 'user' | 'admin' = 'user'): Promise<number> {
  const hash = await bcrypt.hash('Password123!', 4);
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO accounts
       (email, password_hash, zone, zone_location_label, email_verified, role)
     VALUES ($1, $2, '7b', 'Test City', true, $3)
     RETURNING id`,
    [email, hash, role],
  );
  return rows[0].id;
}

async function createParticipant(
  email: string,
  opts: { at?: string; via?: 'invite' | 'guest'; state?: string } = {},
): Promise<number> {
  const id = await createUser(email);
  await pool.query(
    `UPDATE accounts SET beta_participant_at = $2, beta_joined_via = $3,
       residence_state = $4::text,
       residence_state_confirmed_at = CASE WHEN $4::text IS NULL THEN NULL ELSE $5::timestamptz END
     WHERE id = $1`,
    [id, opts.at ?? PARTICIPANT_AT, opts.via ?? 'invite', opts.state ?? null, IN_WINDOW],
  );
  return id;
}

// Each week's first activity is the Tuesday after its Monday, unless given.
async function addWeeks(accountId: number, weeks: string[], firstActiveAt?: string) {
  for (const week of weeks) {
    await pool.query(
      `INSERT INTO beta_active_weeks (account_id, week_start, first_active_at)
       VALUES ($1, $2::date, COALESCE($3::timestamptz, ($2::date + 1)::timestamptz))`,
      [accountId, week, firstActiveAt ?? null],
    );
  }
}

async function addNotes(accountId: number | null, count: number, at = IN_WINDOW) {
  for (let i = 0; i < count; i++) {
    await pool.query(
      `INSERT INTO feedback_submissions (user_id, category, message, created_at)
       VALUES ($1, 'general', 'note', $2)`,
      [accountId, at],
    );
  }
}

async function addQuickAnswers(accountId: number, count: number, at = IN_WINDOW) {
  for (let i = 0; i < count; i++) {
    await pool.query(
      `INSERT INTO micro_feedback_responses (account_id, trigger_key, response, created_at)
       VALUES ($1, 'planted', 'yes', $2)`,
      [accountId, at],
    );
  }
}

async function addSurvey(accountId: number, survey: 1 | 2) {
  await pool.query('INSERT INTO beta_survey_credits (account_id, survey) VALUES ($1, $2)', [
    accountId,
    survey,
  ]);
}

async function loginAgent(email: string) {
  const agent = request.agent(app);
  await agent.post('/api/auth/guest');
  await agent.post('/api/auth/login').send({ email, password: 'Password123!' });
  return agent;
}

async function rowFor(accountId: number) {
  const res = await adminAgent.get(LIFETIME);
  expect(res.status).toBe(200);
  return res.body.rows.find((r: { accountId: number }) => r.accountId === accountId);
}

let originalConfig: ServerConfig;
let adminAgent: ReturnType<typeof request.agent>;
let userAgent: ReturnType<typeof request.agent>;
let guestAgent: ReturnType<typeof request.agent>;

beforeAll(async () => {
  await pool.query(
    'TRUNCATE accounts, guest_sessions, password_reset_tokens, admin_audit_log, feedback_submissions RESTART IDENTITY CASCADE',
  );
  await pool.query(
    `UPDATE beta_settings SET gate_on = false, guest_mode_on = true,
       supporter_access_on = true, gate_first_on_at = NULL WHERE id = 1`,
  );
  originalConfig = getServerConfig();
  setServerConfigForTests({ ...originalConfig, betaEndsAt: new Date(ENDS_AT) });
  await createUser('lifetime-admin@example.com', 'admin');
  await createUser('lifetime-user@example.com', 'user');
  adminAgent = await loginAgent('lifetime-admin@example.com');
  userAgent = await loginAgent('lifetime-user@example.com');
  guestAgent = request.agent(app);
  await guestAgent.post('/api/auth/guest');
});

afterEach(async () => {
  await pool.query('DELETE FROM feedback_submissions');
  await pool.query(
    `DELETE FROM accounts WHERE email NOT IN ('lifetime-admin@example.com', 'lifetime-user@example.com')`,
  );
});

afterAll(async () => {
  setServerConfigForTests(originalConfig);
  await pool.end();
});

describe('GET /api/admin/beta/lifetime', () => {
  it('403 for a non-admin account, a guest and no session, as JSON or CSV', async () => {
    for (const agent of [userAgent, guestAgent, request.agent(app)]) {
      expect((await agent.get(LIFETIME)).status).toBe(403);
      expect((await agent.get(`${LIFETIME}?format=csv`)).status).toBe(403);
    }
  });

  it('400 for an unknown format', async () => {
    const res = await adminAgent.get(`${LIFETIME}?format=xlsx`);
    expect(res.status).toBe(400);
  });

  it('a participant at 3 weeks and 3 feedback qualifies; the full row shape', async () => {
    const id = await createParticipant('three@example.com', { state: 'WA' });
    await addWeeks(id, ['2026-10-19', '2026-10-05', '2026-10-12']);
    await addNotes(id, 1);
    await addQuickAnswers(id, 1);
    await addSurvey(id, 1);

    const res = await adminAgent.get(LIFETIME);
    expect(res.status).toBe(200);
    expect(res.body.endsAt).toBe(ENDS_AT);
    expect(res.body.rows).toEqual([
      {
        accountId: id,
        email: 'three@example.com',
        participantAt: PARTICIPANT_AT,
        joinedVia: 'invite',
        activeWeeks: ['2026-10-05', '2026-10-12', '2026-10-19'],
        activeWeekCount: 3,
        feedback: { notes: 1, quickAnswers: 1, surveys: 1, total: 3 },
        qualifies: true,
        borderline: false,
        residenceState: 'WA',
        residenceStateConfirmedAt: IN_WINDOW,
        grantEligible: true,
      },
    ]);
  });

  it('2 weeks and 2 feedback is borderline and does not qualify', async () => {
    const id = await createParticipant('two@example.com', { state: 'WA' });
    await addWeeks(id, ['2026-10-05', '2026-10-12']);
    await addNotes(id, 2);
    const row = await rowFor(id);
    expect(row).toMatchObject({
      activeWeekCount: 2,
      feedback: { total: 2 },
      qualifies: false,
      borderline: true,
      grantEligible: false,
    });
  });

  it('3 weeks and 2 feedback neither qualifies nor is borderline', async () => {
    const id = await createParticipant('short@example.com', { state: 'WA' });
    await addWeeks(id, ['2026-10-05', '2026-10-12', '2026-10-19']);
    await addQuickAnswers(id, 2);
    const row = await rowFor(id);
    expect(row).toMatchObject({
      activeWeekCount: 3,
      feedback: { notes: 0, quickAnswers: 2, surveys: 0, total: 2 },
      qualifies: false,
      borderline: false,
    });
  });

  it('counts feedback only in [participantAt, BETA_ENDS_AT)', async () => {
    const id = await createParticipant('window@example.com');
    // Before joining, and at or after the end: not counted.
    await addNotes(id, 1, '2026-09-30T23:59:59.000Z');
    await addQuickAnswers(id, 1, '2026-09-15T00:00:00.000Z');
    await addNotes(id, 1, ENDS_AT);
    await addQuickAnswers(id, 1, '2026-12-15T00:00:00.000Z');
    // Exactly at joining, and just before the end: counted.
    await addNotes(id, 1, PARTICIPANT_AT);
    await addQuickAnswers(id, 1, '2026-12-01T07:59:59.000Z');
    const row = await rowFor(id);
    expect(row.feedback).toEqual({ notes: 1, quickAnswers: 1, surveys: 0, total: 2 });
  });

  it('does not count a guest-era feedback note (user_id null)', async () => {
    const id = await createParticipant('guestera@example.com');
    await addNotes(null, 2);
    await addNotes(id, 1);
    const row = await rowFor(id);
    expect(row.feedback.notes).toBe(1);
  });

  it('excludes active weeks first recorded at or after BETA_ENDS_AT', async () => {
    const id = await createParticipant('lateweek@example.com');
    await addWeeks(id, ['2026-10-05', '2026-11-23']);
    await addWeeks(id, ['2026-11-30'], ENDS_AT);
    await addWeeks(id, ['2026-12-07']);
    const row = await rowFor(id);
    expect(row.activeWeeks).toEqual(['2026-10-05', '2026-11-23']);
    expect(row.activeWeekCount).toBe(2);
  });

  it('counts survey credits in the total', async () => {
    const id = await createParticipant('surveys@example.com', { state: 'OR' });
    await addWeeks(id, ['2026-10-05', '2026-10-12', '2026-10-19']);
    await addSurvey(id, 1);
    await addSurvey(id, 2);
    await addNotes(id, 1);
    const row = await rowFor(id);
    expect(row.feedback).toEqual({ notes: 1, quickAnswers: 0, surveys: 2, total: 3 });
    expect(row.qualifies).toBe(true);
    expect(row.grantEligible).toBe(true);
  });

  it('grantEligible needs a listed state: OUTSIDE_US and no state are false', async () => {
    const ids: Record<string, number> = {};
    for (const [key, state] of [['us', 'CA'], ['outside', 'OUTSIDE_US'], ['none', undefined]] as const) {
      const id = await createParticipant(`${key}@example.com`, { state });
      await addWeeks(id, ['2026-10-05', '2026-10-12', '2026-10-19']);
      await addNotes(id, 3);
      ids[key] = id;
    }
    expect(await rowFor(ids.us)).toMatchObject({ qualifies: true, grantEligible: true });
    expect(await rowFor(ids.outside)).toMatchObject({
      qualifies: true,
      residenceState: 'OUTSIDE_US',
      grantEligible: false,
    });
    expect(await rowFor(ids.none)).toMatchObject({
      qualifies: true,
      residenceState: null,
      residenceStateConfirmedAt: null,
      grantEligible: false,
    });
  });

  it('a territory counts as a listed state for grantEligible', async () => {
    const id = await createParticipant('territory@example.com', { state: 'PR' });
    await addWeeks(id, ['2026-10-05', '2026-10-12', '2026-10-19']);
    await addNotes(id, 3);
    expect(await rowFor(id)).toMatchObject({ qualifies: true, grantEligible: true });
  });

  it('lists participants only, newest participant first', async () => {
    const older = await createParticipant('older@example.com', { at: '2026-09-01T00:00:00Z' });
    const newer = await createParticipant('newer@example.com', {
      at: '2026-10-20T00:00:00Z',
      via: 'guest',
    });
    const tieA = await createParticipant('tie-a@example.com', { at: '2026-10-10T00:00:00Z' });
    const tieB = await createParticipant('tie-b@example.com', { at: '2026-10-10T00:00:00Z' });
    const outsider = await createUser('outsider@example.com');
    await addWeeks(outsider, ['2026-10-05']);
    await addNotes(outsider, 3);

    const res = await adminAgent.get(LIFETIME);
    expect(res.body.rows.map((r: { accountId: number }) => r.accountId)).toEqual([
      newer,
      tieB,
      tieA,
      older,
    ]);
    expect(res.body.rows[0].joinedVia).toBe('guest');
  });

  it('serves CSV: header, one row, escaping and the formula guard', async () => {
    const id = await createParticipant('=cmd@example.com', { state: 'WA' });
    await addWeeks(id, ['2026-10-05', '2026-10-12', '2026-10-19']);
    await addNotes(id, 2);
    await addSurvey(id, 1);
    const plain = await createParticipant('plain@example.com', { at: '2026-09-01T00:00:00Z' });

    const pacificDate = () =>
      new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Los_Angeles',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date());
    const before = pacificDate();
    const res = await adminAgent.get(`${LIFETIME}?format=csv`);
    const after = pacificDate();
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    // Either date, so a run straddling Pacific midnight still passes.
    expect([
      `attachment; filename="lifetime-tier-${before}.csv"`,
      `attachment; filename="lifetime-tier-${after}.csv"`,
    ]).toContain(res.headers['content-disposition']);

    expect(res.text).toBe(
      [
        'accountId,email,participantAt,joinedVia,activeWeeks,activeWeekCount,' +
          'feedbackNotes,feedbackQuickAnswers,feedbackSurveys,feedbackTotal,' +
          'qualifies,borderline,residenceState,residenceStateConfirmedAt,grantEligible',
        `${id},'=cmd@example.com,${PARTICIPANT_AT},invite,2026-10-05;2026-10-12;2026-10-19,3,` +
          `2,0,1,3,true,false,WA,${IN_WINDOW},true`,
        `${plain},plain@example.com,2026-09-01T00:00:00.000Z,invite,,0,0,0,0,0,false,false,,,false`,
        '',
      ].join('\r\n'),
    );
  });
});

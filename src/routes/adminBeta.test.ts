import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { Pool } from 'pg';
import app from '../index';
import { invalidateBetaSettings } from '../lib/beta';
import { BETA_TERMS_VERSION } from '../lib/legal';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL must be set to run tests');

const pool = new Pool({ connectionString: url });

async function resetBeta() {
  await pool.query(
    `UPDATE beta_settings SET gate_on = false, guest_mode_on = true,
       supporter_access_on = true, gate_first_on_at = NULL WHERE id = 1`,
  );
  await pool.query('DELETE FROM beta_invites');
  invalidateBetaSettings();
}

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

async function loginAgent(email: string) {
  const agent = request.agent(app);
  await agent.post('/api/auth/guest');
  await agent.post('/api/auth/login').send({ email, password: 'Password123!' });
  return agent;
}

async function audit(action: string) {
  const { rows } = await pool.query(
    `SELECT admin_id, action, target_type, target_id, before, after
     FROM admin_audit_log WHERE action = $1 ORDER BY id`,
    [action],
  );
  // target_id is a bigint column, which pg returns as a string.
  return rows.map((r) => ({ ...r, target_id: Number(r.target_id) }));
}

// Every audit row as text, to check no address leaked into any column.
async function auditText(): Promise<string> {
  const { rows } = await pool.query('SELECT row_to_json(l)::text AS t FROM admin_audit_log l');
  return rows.map((r) => r.t).join('\n');
}

let adminId: number;
let adminAgent: ReturnType<typeof request.agent>;
let userAgent: ReturnType<typeof request.agent>;
let guestAgent: ReturnType<typeof request.agent>;

beforeAll(async () => {
  await pool.query(
    'TRUNCATE accounts, guest_sessions, password_reset_tokens, admin_audit_log RESTART IDENTITY CASCADE',
  );
  await resetBeta();
  adminId = await createUser('beta-admin@example.com', 'admin');
  await createUser('beta-user@example.com', 'user');
  adminAgent = await loginAgent('beta-admin@example.com');
  userAgent = await loginAgent('beta-user@example.com');
  guestAgent = request.agent(app);
  await guestAgent.post('/api/auth/guest');
});

afterEach(async () => {
  await resetBeta();
  await pool.query(
    `DELETE FROM accounts WHERE email NOT IN ('beta-admin@example.com', 'beta-user@example.com')`,
  );
  await pool.query('DELETE FROM admin_audit_log');
});

afterAll(() => pool.end());

describe('admin beta routes require an admin', () => {
  const routes: Array<[string, string, object?]> = [
    ['get', '/api/admin/beta'],
    ['patch', '/api/admin/beta/settings', { gateOn: true }],
    ['get', '/api/admin/beta/invites'],
    ['post', '/api/admin/beta/invites', { emails: 'a@example.com' }],
    ['delete', '/api/admin/beta/invites/1'],
    ['post', '/api/admin/beta/invites/cleanup'],
    ['post', '/api/admin/beta/survey-credits', { accountId: 1, survey: 1 }],
    ['delete', '/api/admin/beta/survey-credits/1/1'],
  ];
  for (const [method, path, body] of routes) {
    it(`${method.toUpperCase()} ${path}: 403 for a non-admin account, a guest and no session`, async () => {
      for (const agent of [userAgent, guestAgent, request.agent(app)]) {
        const res = await (agent as unknown as Record<string, (p: string) => request.Test>)[method](path)
          .send(body);
        expect(res.status).toBe(403);
      }
    });
  }

  it('changes nothing when refused', async () => {
    await userAgent.patch('/api/admin/beta/settings').send({ gateOn: true });
    await userAgent.post('/api/admin/beta/invites').send({ emails: 'a@example.com' });
    const settings = await pool.query('SELECT gate_on FROM beta_settings');
    const invites = await pool.query('SELECT 1 FROM beta_invites');
    expect(settings.rows[0].gate_on).toBe(false);
    expect(invites.rowCount).toBe(0);
  });
});

describe('GET /api/admin/beta', () => {
  it('returns defaults and numeric counts', async () => {
    const res = await adminAgent.get('/api/admin/beta');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      gateOn: false,
      gateFirstOnAt: null,
      guestModeOn: true,
      supporterAccessOn: true,
      counts: { invited: 0, haveAccounts: 0, participants: 0 },
    });
  });

  it('counts invites, invites with accounts and participants', async () => {
    await createUser('has-account@example.com');
    await adminAgent
      .post('/api/admin/beta/invites')
      .send({ emails: 'has-account@example.com, no-account@example.com' });
    // An invite whose account is not a participant (inserted directly).
    await createUser('unpromoted@example.com');
    await pool.query(`INSERT INTO beta_invites (email) VALUES ('unpromoted@example.com')`);
    // Participants with no invite.
    for (const email of ['solo1@example.com', 'solo2@example.com']) {
      const id = await createUser(email);
      await pool.query('UPDATE accounts SET beta_participant_at = now() WHERE id = $1', [id]);
    }
    const res = await adminAgent.get('/api/admin/beta');
    // invited: 3 rows; haveAccounts: 2 of them; participants: 1 invited + 2 solo.
    expect(res.body.counts).toEqual({ invited: 3, haveAccounts: 2, participants: 3 });
  });

  it('reads the table directly, not the cache', async () => {
    await adminAgent.get('/api/admin/beta');
    await pool.query('UPDATE beta_settings SET supporter_access_on = false WHERE id = 1');
    const res = await adminAgent.get('/api/admin/beta');
    expect(res.body.supporterAccessOn).toBe(false);
  });
});

describe('PATCH /api/admin/beta/settings', () => {
  it('rejects zero keys, two keys, extra keys, unknown keys and non-booleans', async () => {
    const bad: unknown[] = [
      {},
      { gateOn: true, guestModeOn: false },
      { gateOn: true, extra: 1 },
      { extra: true },
      { gateOn: 'true' },
      { gateOn: 1 },
      { gateOn: null },
      { constructor: true },
      [],
      'gateOn',
    ];
    for (const body of bad) {
      const res = await adminAgent.patch('/api/admin/beta/settings').send(body as object);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(await audit('beta.setting')).toHaveLength(0);
  });

  it('updates the field, returns the GET shape and audits before/after', async () => {
    const res = await adminAgent.patch('/api/admin/beta/settings').send({ guestModeOn: false });
    expect(res.status).toBe(200);
    expect(res.body).toEqual((await adminAgent.get('/api/admin/beta')).body);
    expect(res.body.guestModeOn).toBe(false);

    const rows = await audit('beta.setting');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      admin_id: adminId,
      action: 'beta.setting',
      target_type: 'beta_settings',
      target_id: 1,
      before: { guestModeOn: true },
      after: { guestModeOn: false },
    });
  });

  it('audits each of the three settings by its own name', async () => {
    await adminAgent.patch('/api/admin/beta/settings').send({ gateOn: true });
    await adminAgent.patch('/api/admin/beta/settings').send({ supporterAccessOn: false });
    const rows = await audit('beta.setting');
    expect(rows.map((r) => r.after)).toEqual([{ gateOn: true }, { supporterAccessOn: false }]);
    expect(rows.map((r) => r.before)).toEqual([{ gateOn: false }, { supporterAccessOn: true }]);
  });

  it('is seen by the next request: guest mode off refuses a new guest', async () => {
    // Warm the cache with the old value.
    expect((await request(app).post('/api/auth/guest')).status).toBe(201);
    const res = await adminAgent.patch('/api/admin/beta/settings').send({ guestModeOn: false });
    expect(res.status).toBe(200);
    const guest = await request(app).post('/api/auth/guest');
    expect(guest.status).toBe(403);
    expect(guest.body.code).toBe('guest_mode_off');
  });

  it('sets updated_at', async () => {
    await pool.query(`UPDATE beta_settings SET updated_at = '2020-01-01' WHERE id = 1`);
    await adminAgent.patch('/api/admin/beta/settings').send({ supporterAccessOn: false });
    const { rows } = await pool.query('SELECT updated_at FROM beta_settings');
    expect(rows[0].updated_at.getFullYear()).toBeGreaterThan(2020);
  });

  it('keeps the first gate_first_on_at across on, off, on', async () => {
    const on1 = await adminAgent.patch('/api/admin/beta/settings').send({ gateOn: true });
    const first = on1.body.gateFirstOnAt;
    expect(first).toEqual(expect.any(String));
    expect(Number.isNaN(Date.parse(first))).toBe(false);

    const off = await adminAgent.patch('/api/admin/beta/settings').send({ gateOn: false });
    expect(off.body.gateOn).toBe(false);
    expect(off.body.gateFirstOnAt).toBe(first);

    await new Promise((r) => setTimeout(r, 15));
    const on2 = await adminAgent.patch('/api/admin/beta/settings').send({ gateOn: true });
    expect(on2.body.gateOn).toBe(true);
    expect(on2.body.gateFirstOnAt).toBe(first);
  });

  it('setting guestModeOn or supporterAccessOn does not set gate_first_on_at', async () => {
    const res = await adminAgent.patch('/api/admin/beta/settings').send({ guestModeOn: false });
    expect(res.body.gateFirstOnAt).toBeNull();
  });

  it('a no-op change returns the GET shape without auditing', async () => {
    const res = await adminAgent.patch('/api/admin/beta/settings').send({ gateOn: false });
    expect(res.status).toBe(200);
    expect(res.body.gateOn).toBe(false);
    expect(await audit('beta.setting')).toHaveLength(0);

    await adminAgent.patch('/api/admin/beta/settings').send({ gateOn: true });
    const again = await adminAgent.patch('/api/admin/beta/settings').send({ gateOn: true });
    expect(again.status).toBe(200);
    expect(await audit('beta.setting')).toHaveLength(1);
  });
});

describe('GET /api/admin/beta/invites', () => {
  it('lists newest first with accountCreatedAt or null', async () => {
    await createUser('old-account@example.com');
    await pool.query(`INSERT INTO beta_invites (email, added_at) VALUES ('old-account@example.com', '2026-01-01')`);
    await pool.query(`INSERT INTO beta_invites (email, added_at) VALUES ('new-one@example.com', '2026-02-01')`);
    await pool.query(`INSERT INTO beta_invites (email, added_at) VALUES ('same-time@example.com', '2026-02-01')`);

    const res = await adminAgent.get('/api/admin/beta/invites');
    expect(res.status).toBe(200);
    expect(res.body.data.map((r: { email: string }) => r.email)).toEqual([
      'same-time@example.com',
      'new-one@example.com',
      'old-account@example.com',
    ]);
    const [a, b, c] = res.body.data;
    expect(Object.keys(a).sort()).toEqual(['accountCreatedAt', 'addedAt', 'email', 'id']);
    expect(a.accountCreatedAt).toBeNull();
    expect(b.accountCreatedAt).toBeNull();
    expect(typeof c.accountCreatedAt).toBe('string');
    expect(typeof a.addedAt).toBe('string');
  });
});

describe('POST /api/admin/beta/invites', () => {
  it('requires emails to be a string', async () => {
    for (const body of [{}, { emails: ['a@example.com'] }, { emails: 5 }, { emails: null }]) {
      const res = await adminAgent.post('/api/admin/beta/invites').send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('allows 500 addresses and refuses 501 without writing anything', async () => {
    const make = (n: number) =>
      Array.from({ length: n }, (_, i) => `bulk${i}@example.com`).join(',');
    const refused = await adminAgent.post('/api/admin/beta/invites').send({ emails: make(501) });
    expect(refused.status).toBe(400);
    expect((await pool.query('SELECT 1 FROM beta_invites')).rowCount).toBe(0);

    const ok = await adminAgent.post('/api/admin/beta/invites').send({ emails: make(500) });
    expect(ok.status).toBe(200);
    expect(ok.body.added).toHaveLength(500);
    expect(ok.body.added[0]).toBe('bulk0@example.com');
    expect(ok.body.added[499]).toBe('bulk499@example.com');
  });

  it('handles the spec input: lowercases, de-duplicates, returns invalid as typed', async () => {
    const res = await adminAgent
      .post('/api/admin/beta/invites')
      .send({ emails: 'Jane@Example.com, bob@example.com\nbob@example.com, nope@' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      added: ['jane@example.com', 'bob@example.com'],
      alreadyListed: [],
      newParticipants: [],
      invalid: ['nope@'],
    });
    const { rows } = await pool.query('SELECT email, added_by FROM beta_invites ORDER BY email');
    expect(rows).toEqual([
      { email: 'bob@example.com', added_by: adminId },
      { email: 'jane@example.com', added_by: adminId },
    ]);
  });

  it('returns invalid tokens as typed (case kept) and de-duplicates them', async () => {
    const res = await adminAgent
      .post('/api/admin/beta/invites')
      .send({ emails: 'NOPE@ nope@ NOPE@ bad address@x' });
    expect(res.body.invalid).toEqual(['NOPE@', 'nope@', 'bad', 'address@x']);
    expect(res.body.added).toEqual([]);
  });

  it('is empty-safe: no valid emails, empty string, only separators', async () => {
    for (const emails of ['', ' , \n ', 'nope@']) {
      const res = await adminAgent.post('/api/admin/beta/invites').send({ emails });
      expect(res.status).toBe(200);
      expect(res.body.added).toEqual([]);
      expect(res.body.alreadyListed).toEqual([]);
      expect(res.body.newParticipants).toEqual([]);
    }
    expect(await audit('beta.invite.add')).toHaveLength(0);
  });

  it('reports already-listed emails and does not add them twice', async () => {
    await adminAgent.post('/api/admin/beta/invites').send({ emails: 'a@example.com' });
    const res = await adminAgent
      .post('/api/admin/beta/invites')
      .send({ emails: 'A@example.com, b@example.com' });
    expect(res.body.added).toEqual(['b@example.com']);
    expect(res.body.alreadyListed).toEqual(['a@example.com']);
    const { rowCount } = await pool.query('SELECT 1 FROM beta_invites');
    expect(rowCount).toBe(2);
  });

  it('audits one row per inserted invite only, without the address', async () => {
    await adminAgent.post('/api/admin/beta/invites').send({ emails: 'a@example.com b@example.com' });
    await adminAgent.post('/api/admin/beta/invites').send({ emails: 'b@example.com c@example.com' });
    const rows = await audit('beta.invite.add');
    expect(rows).toHaveLength(3);
    const { rows: invites } = await pool.query('SELECT id FROM beta_invites ORDER BY id');
    expect(rows.map((r) => r.target_id)).toEqual(invites.map((i) => i.id));
    for (const r of rows) {
      expect(r).toMatchObject({
        admin_id: adminId,
        target_type: 'beta_invite',
        before: null,
        after: null,
      });
    }
    expect(await auditText()).not.toContain('example.com');
  });

  it("makes an existing account a participant, reports it, and doesn't change the date on re-add", async () => {
    await createUser('existing@example.com');
    const res = await adminAgent.post('/api/admin/beta/invites').send({ emails: 'Existing@example.com' });
    expect(res.body.added).toEqual(['existing@example.com']);
    expect(res.body.newParticipants).toEqual(['existing@example.com']);

    const first = await pool.query(
      `SELECT beta_participant_at, beta_joined_via FROM accounts WHERE email = 'existing@example.com'`,
    );
    expect(first.rows[0].beta_participant_at).toBeInstanceOf(Date);
    expect(first.rows[0].beta_joined_via).toBe('invite');

    await new Promise((r) => setTimeout(r, 15));
    const again = await adminAgent.post('/api/admin/beta/invites').send({ emails: 'existing@example.com' });
    expect(again.body.added).toEqual([]);
    expect(again.body.alreadyListed).toEqual(['existing@example.com']);
    expect(again.body.newParticipants).toEqual([]);

    const second = await pool.query(
      `SELECT beta_participant_at, beta_joined_via FROM accounts WHERE email = 'existing@example.com'`,
    );
    expect(second.rows[0].beta_participant_at).toEqual(first.rows[0].beta_participant_at);
    expect(second.rows[0].beta_joined_via).toBe('invite');
  });

  it('heals a listed email whose account appeared later', async () => {
    await adminAgent.post('/api/admin/beta/invites').send({ emails: 'late@example.com' });
    await createUser('late@example.com');
    const res = await adminAgent.post('/api/admin/beta/invites').send({ emails: 'late@example.com' });
    expect(res.body.alreadyListed).toEqual(['late@example.com']);
    expect(res.body.newParticipants).toEqual(['late@example.com']);
    const { rows } = await pool.query(`SELECT beta_joined_via FROM accounts WHERE email = 'late@example.com'`);
    expect(rows[0].beta_joined_via).toBe('invite');
  });

  it('leaves an account that is already a participant out of newParticipants', async () => {
    const id = await createUser('already@example.com');
    await pool.query(`UPDATE accounts SET beta_participant_at = '2026-05-05' WHERE id = $1`, [id]);
    const res = await adminAgent.post('/api/admin/beta/invites').send({ emails: 'already@example.com' });
    expect(res.body.added).toEqual(['already@example.com']);
    expect(res.body.newParticipants).toEqual([]);
  });

  it("doesn't change how an existing participant joined", async () => {
    const id = await createUser('guestjoined@example.com');
    await pool.query(
      `UPDATE accounts SET beta_participant_at = '2026-05-05', beta_joined_via = 'guest' WHERE id = $1`,
      [id],
    );
    await adminAgent.post('/api/admin/beta/invites').send({ emails: 'guestjoined@example.com' });
    const { rows } = await pool.query('SELECT beta_participant_at, beta_joined_via FROM accounts WHERE id = $1', [id]);
    expect(rows[0].beta_participant_at).toEqual(new Date('2026-05-05'));
    expect(rows[0].beta_joined_via).toBe('guest');
  });

  it('a new participant is held by the terms gate until they accept', async () => {
    await createUser('gated@example.com');
    await adminAgent.post('/api/admin/beta/invites').send({ emails: 'gated@example.com' });
    const agent = await loginAgent('gated@example.com');
    const blocked = await agent.get('/api/gardens');
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('beta_terms_required');
  });
});

describe('DELETE /api/admin/beta/invites/:id', () => {
  it('404 for a missing id, 400 for a non-numeric id', async () => {
    expect((await adminAgent.delete('/api/admin/beta/invites/99999')).status).toBe(404);
    expect((await adminAgent.delete('/api/admin/beta/invites/abc')).status).toBe(400);
    expect(await audit('beta.invite.remove')).toHaveLength(0);
  });

  it('deletes the invite, audits it without the address, and returns 204', async () => {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO beta_invites (email) VALUES ('gone@example.com') RETURNING id`,
    );
    const id = rows[0].id;
    const res = await adminAgent.delete(`/api/admin/beta/invites/${id}`);
    expect(res.status).toBe(204);
    expect((await pool.query('SELECT 1 FROM beta_invites WHERE id = $1', [id])).rowCount).toBe(0);

    const log = await audit('beta.invite.remove');
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      admin_id: adminId,
      target_type: 'beta_invite',
      target_id: id,
      before: null,
      after: null,
    });
    expect(await auditText()).not.toContain('gone@example.com');
  });

  it('leaves the account, its sessions and its participant date as they were', async () => {
    await createUser('keeper@example.com');
    await adminAgent.post('/api/admin/beta/invites').send({ emails: 'keeper@example.com' });
    await pool.query(
      `UPDATE accounts SET beta_terms_version = $1 WHERE email = 'keeper@example.com'`,
      [BETA_TERMS_VERSION],
    );
    const agent = await loginAgent('keeper@example.com');

    const snapshot = async () => {
      const acc = await pool.query(
        `SELECT id, beta_participant_at, beta_terms_version FROM accounts WHERE email = 'keeper@example.com'`,
      );
      const sess = await pool.query(
        'SELECT id FROM guest_sessions WHERE account_id = $1 ORDER BY id',
        [acc.rows[0].id],
      );
      return { account: acc.rows[0], sessions: sess.rows };
    };
    const before = await snapshot();
    expect(before.account.beta_participant_at).toBeInstanceOf(Date);
    expect(before.sessions.length).toBeGreaterThan(0);

    const { rows } = await pool.query<{ id: number }>(
      `SELECT id FROM beta_invites WHERE email = 'keeper@example.com'`,
    );
    expect((await adminAgent.delete(`/api/admin/beta/invites/${rows[0].id}`)).status).toBe(204);

    expect(await snapshot()).toEqual(before);
    const session = await agent.get('/api/auth/session');
    expect(session.body.data.authenticated).toBe(true);
  });
});

describe('POST /api/admin/beta/invites/cleanup', () => {
  it('removes only invites no account uses, audits the count once, and returns it', async () => {
    await createUser('kept@example.com');
    await pool.query(
      `INSERT INTO beta_invites (email)
       VALUES ('kept@example.com'), ('unused1@example.com'), ('unused2@example.com')`,
    );

    const res = await adminAgent.post('/api/admin/beta/invites/cleanup');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ removed: 2 });

    const { rows } = await pool.query('SELECT email FROM beta_invites');
    expect(rows.map((r) => r.email)).toEqual(['kept@example.com']);

    const log = await audit('beta.invite.cleanup');
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      admin_id: adminId,
      target_type: 'beta_settings',
      target_id: 1,
      before: null,
      after: { removed: 2 },
    });
    expect(await auditText()).not.toContain('example.com');
  });

  it('keeps an invite whose account email differs only in case', async () => {
    await createUser('Mixed@Example.com');
    await pool.query(`INSERT INTO beta_invites (email) VALUES ('mixed@example.com')`);
    const res = await adminAgent.post('/api/admin/beta/invites/cleanup');
    expect(res.body).toEqual({ removed: 0 });
    expect((await pool.query('SELECT 1 FROM beta_invites')).rowCount).toBe(1);
  });

  it('with nothing to remove still answers and audits zero', async () => {
    const res = await adminAgent.post('/api/admin/beta/invites/cleanup');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ removed: 0 });
    expect((await audit('beta.invite.cleanup'))[0].after).toEqual({ removed: 0 });
  });

  it('removes nothing for a non-admin', async () => {
    await pool.query(`INSERT INTO beta_invites (email) VALUES ('stays@example.com')`);
    expect((await userAgent.post('/api/admin/beta/invites/cleanup')).status).toBe(403);
    expect((await pool.query('SELECT 1 FROM beta_invites')).rowCount).toBe(1);
    expect(await audit('beta.invite.cleanup')).toHaveLength(0);
  });
});

describe('survey credits', () => {
  async function createParticipant(email: string): Promise<number> {
    const id = await createUser(email);
    await pool.query('UPDATE accounts SET beta_participant_at = now() WHERE id = $1', [id]);
    return id;
  }

  async function credits(accountId: number) {
    const { rows } = await pool.query(
      'SELECT survey, credited_by FROM beta_survey_credits WHERE account_id = $1 ORDER BY survey',
      [accountId],
    );
    return rows;
  }

  it('adds a credit with credited_by, audits it, and returns 201', async () => {
    const id = await createParticipant('survey@example.com');
    const res = await adminAgent.post('/api/admin/beta/survey-credits').send({ accountId: id, survey: 1 });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ accountId: id, survey: 1, creditedAt: expect.any(String) });
    expect(await credits(id)).toEqual([{ survey: 1, credited_by: adminId }]);

    expect(await audit('beta.survey_credit.add')).toEqual([
      {
        admin_id: adminId,
        action: 'beta.survey_credit.add',
        target_type: 'account',
        target_id: id,
        before: null,
        after: { survey: 1 },
      },
    ]);
  });

  it('409 for a duplicate, without a second audit row; the other survey is separate', async () => {
    const id = await createParticipant('survey@example.com');
    await adminAgent.post('/api/admin/beta/survey-credits').send({ accountId: id, survey: 2 });
    const dup = await adminAgent.post('/api/admin/beta/survey-credits').send({ accountId: id, survey: 2 });
    expect(dup.status).toBe(409);
    expect(await audit('beta.survey_credit.add')).toHaveLength(1);

    const other = await adminAgent.post('/api/admin/beta/survey-credits').send({ accountId: id, survey: 1 });
    expect(other.status).toBe(201);
    expect((await credits(id)).map((r) => r.survey)).toEqual([1, 2]);
  });

  it('removes a credit (204), audits it, 404 on removing again, and re-adds (201)', async () => {
    const id = await createParticipant('survey@example.com');
    await adminAgent.post('/api/admin/beta/survey-credits').send({ accountId: id, survey: 1 });

    const removed = await adminAgent.delete(`/api/admin/beta/survey-credits/${id}/1`);
    expect(removed.status).toBe(204);
    expect(await credits(id)).toEqual([]);
    expect(await audit('beta.survey_credit.remove')).toEqual([
      {
        admin_id: adminId,
        action: 'beta.survey_credit.remove',
        target_type: 'account',
        target_id: id,
        before: { survey: 1 },
        after: null,
      },
    ]);

    const again = await adminAgent.delete(`/api/admin/beta/survey-credits/${id}/1`);
    expect(again.status).toBe(404);
    expect(await audit('beta.survey_credit.remove')).toHaveLength(1);

    const readd = await adminAgent.post('/api/admin/beta/survey-credits').send({ accountId: id, survey: 1 });
    expect(readd.status).toBe(201);
    expect(await credits(id)).toHaveLength(1);
  });

  it('404 for a non-participant or a missing account, writing nothing', async () => {
    const id = await createUser('not-participant@example.com');
    for (const accountId of [id, 999999]) {
      const res = await adminAgent.post('/api/admin/beta/survey-credits').send({ accountId, survey: 1 });
      expect(res.status).toBe(404);
    }
    expect((await pool.query('SELECT 1 FROM beta_survey_credits')).rowCount).toBe(0);
    expect(await audit('beta.survey_credit.add')).toHaveLength(0);
  });

  it('400 for a bad survey or account id', async () => {
    const id = await createParticipant('survey@example.com');
    const bodies = [
      { accountId: id, survey: 3 },
      { accountId: id, survey: '1' },
      { accountId: id, survey: 0 },
      { accountId: id },
      { accountId: String(id), survey: 1 },
      { accountId: 0, survey: 1 },
      { accountId: 1.5, survey: 1 },
      { accountId: 2_147_483_648, survey: 1 },
    ];
    for (const body of bodies) {
      const res = await adminAgent.post('/api/admin/beta/survey-credits').send(body);
      expect(res.status).toBe(400);
    }
    for (const path of [`${id}/3`, `${id}/01`, `abc/1`, `0/1`]) {
      const res = await adminAgent.delete(`/api/admin/beta/survey-credits/${path}`);
      expect(res.status).toBe(400);
    }
    expect((await pool.query('SELECT 1 FROM beta_survey_credits')).rowCount).toBe(0);
  });

  it('changes nothing for a non-admin', async () => {
    const id = await createParticipant('survey@example.com');
    await pool.query('INSERT INTO beta_survey_credits (account_id, survey) VALUES ($1, 2)', [id]);
    const add = await userAgent.post('/api/admin/beta/survey-credits').send({ accountId: id, survey: 1 });
    const del = await userAgent.delete(`/api/admin/beta/survey-credits/${id}/2`);
    expect(add.status).toBe(403);
    expect(del.status).toBe(403);
    expect((await credits(id)).map((r) => r.survey)).toEqual([2]);
  });
});

describe('beta_participant_at trigger', () => {
  it('raises when a set date is cleared or changed, and allows setting it once', async () => {
    const id = await createUser('trigger@example.com');
    await pool.query(`UPDATE accounts SET beta_participant_at = '2026-03-03' WHERE id = $1`, [id]);

    await expect(
      pool.query('UPDATE accounts SET beta_participant_at = NULL WHERE id = $1', [id]),
    ).rejects.toThrow(/beta_participant_at is permanent/);
    await expect(
      pool.query(`UPDATE accounts SET beta_participant_at = '2026-04-04' WHERE id = $1`, [id]),
    ).rejects.toThrow(/beta_participant_at is permanent/);

    const { rows } = await pool.query('SELECT beta_participant_at FROM accounts WHERE id = $1', [id]);
    expect(rows[0].beta_participant_at).toEqual(new Date('2026-03-03'));
  });
});

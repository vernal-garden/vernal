import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { Pool } from 'pg';
import app from '../index';
import { EVENT_KEYS } from '../lib/eventKeys';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL must be set to run tests');

const pool = new Pool({ connectionString: url });

async function resetDb() {
  await pool.query(
    'TRUNCATE accounts, guest_sessions, password_reset_tokens RESTART IDENTITY CASCADE',
  );
}

async function createUser(
  email: string,
  role: 'user' | 'admin' = 'user',
  password = 'Password123!',
): Promise<number> {
  const hash = await bcrypt.hash(password, 4);
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO accounts
       (email, password_hash, zone, zone_location_label, email_verified, role)
     VALUES ($1, $2, '7b', 'Test City', true, $3)
     RETURNING id`,
    [email, hash, role],
  );
  return rows[0].id;
}

async function loginAgent(email: string, password = 'Password123!') {
  const agent = request.agent(app);
  await agent.post('/api/auth/guest');
  await agent.post('/api/auth/login').send({ email, password });
  return agent;
}

let adminId: number;
let adminAgent: ReturnType<typeof request.agent>;
let userAgent: ReturnType<typeof request.agent>;

const ADMIN_EMAIL = 'admin-dashboard@example.com';
const USER_EMAIL = 'regular-user@example.com';

beforeAll(async () => {
  await resetDb();
  adminId = await createUser(ADMIN_EMAIL, 'admin');
  await createUser(USER_EMAIL, 'user');
  adminAgent = await loginAgent(ADMIN_EMAIL);
  userAgent = await loginAgent(USER_EMAIL);
});

afterAll(() => pool.end());

// ── GET /api/admin/stats ──────────────────────────────────────────────────────

describe('GET /api/admin/stats', () => {
  it('returns 403 with no session', async () => {
    const res = await request(app).get('/api/admin/stats');
    expect(res.status).toBe(403);
  });

  it('returns 403 for a regular user', async () => {
    const res = await userAgent.get('/api/admin/stats');
    expect(res.status).toBe(403);
  });

  it('returns 200 with accounts and subscriptions for an admin', async () => {
    const res = await adminAgent.get('/api/admin/stats');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('accounts');
    expect(res.body).toHaveProperty('subscriptions');
  });
});

// ── GET /api/admin/accounts ───────────────────────────────────────────────────

describe('GET /api/admin/accounts', () => {
  it('returns an array of accounts for an admin', async () => {
    const res = await adminAgent.get('/api/admin/accounts');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('finds the admin account via ?email= search', async () => {
    const res = await adminAgent.get(
      `/api/admin/accounts?email=${encodeURIComponent(ADMIN_EMAIL)}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.data.some((a: { email: string }) => a.email === ADMIN_EMAIL)).toBe(true);
  });
});

// ── GET /api/admin/accounts/:id ───────────────────────────────────────────────

describe('GET /api/admin/accounts/:id', () => {
  it('returns the account with an integer gardenCount for an admin', async () => {
    const res = await adminAgent.get(`/api/admin/accounts/${adminId}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.gardenCount).toBe('number');
    expect(Number.isInteger(res.body.gardenCount)).toBe(true);
  });

  it('returns 404 for a nonexistent account', async () => {
    const res = await adminAgent.get('/api/admin/accounts/99999');
    expect(res.status).toBe(404);
  });
});

// ══ Phase 37 ═════════════════════════════════════════════════════════════════

const SEED_PREFIX = '__test__admin_';
const SEED_PREFIX_LIKE = `DELETE FROM cambium.seeds WHERE common_name LIKE '\\_\\_test\\_\\_admin\\_%'`;
const PHASE37_TABLES =
  'TRUNCATE moderation_items, feedback_submissions, usage_events, micro_feedback_responses, job_runs RESTART IDENTITY CASCADE';

async function insertCambiumSeed(name: string, source: 'openfarm' | 'community' | 'editorial') {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO cambium.seeds (common_name, source) VALUES ($1, $2) RETURNING id`,
    [`${SEED_PREFIX}${name}`, source],
  );
  return rows[0].id;
}

async function insertModerationItem(opts: {
  type: 'correction' | 'new_seed';
  status?: string;
  cambiumSeedId?: number | null;
  seedId?: number | null;
  submittedBy?: number | null;
  content?: Record<string, unknown>;
}) {
  const status = opts.status ?? 'new';
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO moderation_items (type, status, cambium_seed_id, seed_id, submitted_by, content, resolved_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      opts.type,
      status,
      opts.cambiumSeedId ?? null,
      opts.seedId ?? null,
      opts.submittedBy ?? null,
      JSON.stringify(opts.content ?? {}),
      status === 'approved' || status === 'rejected' ? new Date() : null,
    ],
  );
  return rows[0].id;
}

async function insertPersonalSeed(ownerId: number, name: string) {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO seeds (owner_id, common_name, origin, contribution_status)
     VALUES ($1, $2, 'user_created', 'pending') RETURNING id`,
    [ownerId, name],
  );
  return rows[0].id;
}

async function insertFeedback(status: string, minutesAgo: number) {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO feedback_submissions (category, message, source_surface, status, created_at)
     VALUES ('bug', $1, 'canvas', $2, now() - make_interval(mins => $3)) RETURNING id`,
    [`Feedback in status ${status}`, status, minutesAgo],
  );
  return rows[0].id;
}

async function regularUserId(): Promise<number> {
  const { rows } = await pool.query<{ id: number }>('SELECT id FROM accounts WHERE email = $1', [
    USER_EMAIL,
  ]);
  return rows[0].id;
}

describe('Phase 37 admin API', () => {
  beforeAll(async () => {
    await pool.query(PHASE37_TABLES);
    await pool.query(SEED_PREFIX_LIKE);
  });

  afterAll(async () => {
    await pool.query(PHASE37_TABLES);
    await pool.query(SEED_PREFIX_LIKE);
  });

  // ── Access ──────────────────────────────────────────────────────────────────

  describe('access', () => {
    const GET_ENDPOINTS = [
      '/api/admin/seeds/summary',
      '/api/admin/seeds',
      '/api/admin/moderation',
      '/api/admin/moderation/1',
      '/api/admin/users/summary',
      '/api/admin/users/charts',
      '/api/admin/features',
      '/api/admin/feedback',
      '/api/admin/feedback/1',
      '/api/admin/system',
    ];

    it.each(GET_ENDPOINTS)('returns 403 for a regular user on GET %s', async (path) => {
      const res = await userAgent.get(path);
      expect(res.status).toBe(403);
    });
  });

  // ── Accounts ────────────────────────────────────────────────────────────────

  describe('account actions', () => {
    let targetId: number;

    beforeAll(async () => {
      targetId = await createUser('tier-role-target@example.com', 'user');
    });

    it('overrides the tier of another account', async () => {
      const res = await adminAgent
        .patch(`/api/admin/accounts/${targetId}/tier`)
        .send({ tier: 'supporter' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: targetId, subscriptionTier: 'supporter' });

      const { rows } = await pool.query('SELECT subscription_tier FROM accounts WHERE id = $1', [
        targetId,
      ]);
      expect(rows[0].subscription_tier).toBe('supporter');
    });

    it('rejects an invalid tier with 400', async () => {
      const res = await adminAgent
        .patch(`/api/admin/accounts/${targetId}/tier`)
        .send({ tier: 'platinum' });
      expect(res.status).toBe(400);
    });

    it('returns 404 for a tier override on a nonexistent account', async () => {
      const res = await adminAgent.patch('/api/admin/accounts/99999/tier').send({ tier: 'free' });
      expect(res.status).toBe(404);
    });

    it('returns 400 for a non-numeric id', async () => {
      const res = await adminAgent.patch('/api/admin/accounts/abc/tier').send({ tier: 'free' });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Invalid id' });
    });

    it('changes the role of another account', async () => {
      const res = await adminAgent
        .patch(`/api/admin/accounts/${targetId}/role`)
        .send({ role: 'admin' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: targetId, role: 'admin' });
    });

    it('refuses to change your own role with 403', async () => {
      const res = await adminAgent
        .patch(`/api/admin/accounts/${adminId}/role`)
        .send({ role: 'user' });
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'Cannot change your own role.' });
    });
  });

  // ── Seed DB ─────────────────────────────────────────────────────────────────

  describe('seed DB', () => {
    it('summary counts community seeds separately from the total', async () => {
      const before = await adminAgent.get('/api/admin/seeds/summary');
      expect(before.status).toBe(200);

      await insertCambiumSeed('Alpha Bean', 'community');
      await insertCambiumSeed('Beta Kale', 'openfarm');

      const after = await adminAgent.get('/api/admin/seeds/summary');
      expect(after.body.totalSeeds - before.body.totalSeeds).toBe(2);
      expect(after.body.communitySeeds - before.body.communitySeeds).toBe(1);
      expect(after.body.addedThisMonth - before.body.addedThisMonth).toBe(2);
      expect(typeof after.body.pendingModeration).toBe('number');
    });

    it('source=community returns only community seeds', async () => {
      const res = await adminAgent.get(
        `/api/admin/seeds?source=community&q=${encodeURIComponent(SEED_PREFIX)}`,
      );
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThan(0);
      expect(res.body.data.every((s: { source: string }) => s.source === 'community')).toBe(true);
      expect(res.body.total).toBe(res.body.data.length);
    });

    it('hasCorrections=true returns only seeds with open corrections, counting unresolved only', async () => {
      const seedWithOpen = await insertCambiumSeed('Gamma Pea', 'openfarm');
      const seedResolvedOnly = await insertCambiumSeed('Delta Leek', 'editorial');
      await insertModerationItem({ type: 'correction', cambiumSeedId: seedWithOpen });
      await insertModerationItem({
        type: 'correction',
        cambiumSeedId: seedWithOpen,
        status: 'rejected',
      });
      await insertModerationItem({
        type: 'correction',
        cambiumSeedId: seedResolvedOnly,
        status: 'approved',
      });

      const res = await adminAgent.get(
        `/api/admin/seeds?hasCorrections=true&q=${encodeURIComponent(SEED_PREFIX)}`,
      );
      expect(res.status).toBe(200);
      expect(res.body.data.map((s: { id: number }) => s.id)).toEqual([seedWithOpen]);
      expect(res.body.data[0].openCorrections).toBe(1);
      expect(res.body.data[0].rawSource).toBe('openfarm');
      expect(res.body.data[0].source).toBe('cambium');
    });

    it('falls back to common_name for an unknown sort value', async () => {
      const res = await adminAgent.get(
        `/api/admin/seeds?sort=${encodeURIComponent('constructor; DROP')}&q=${encodeURIComponent(SEED_PREFIX)}`,
      );
      expect(res.status).toBe(200);
      const names: string[] = res.body.data.map((s: { commonName: string }) => s.commonName);
      expect(names).toHaveLength(4);
      expect(names).toEqual([...names].sort());
    });
  });

  // ── Moderation ──────────────────────────────────────────────────────────────

  describe('moderation', () => {
    let cambiumSeedId: number;
    let anonCorrectionId: number;
    let userId: number;

    beforeAll(async () => {
      await pool.query('TRUNCATE moderation_items RESTART IDENTITY');
      userId = await regularUserId();
      cambiumSeedId = await insertCambiumSeed('Epsilon Squash', 'openfarm');
      anonCorrectionId = await insertModerationItem({
        type: 'correction',
        cambiumSeedId,
        submittedBy: null,
        content: { correctionText: 'Spacing is wrong', seedName: 'Old name' },
      });
      await insertModerationItem({ type: 'correction', cambiumSeedId, status: 'approved' });
    });

    it('default tab lists only unresolved items, with counts', async () => {
      const res = await adminAgent.get('/api/admin/moderation');
      expect(res.status).toBe(200);
      expect(res.body.tab).toBe('all');
      expect(res.body.data).toHaveLength(1);
      expect(
        res.body.data.every((m: { status: string }) => ['new', 'under_review'].includes(m.status)),
      ).toBe(true);
      expect(res.body.counts).toEqual({ all: 1, corrections: 1, newSeeds: 0, resolved: 1 });
      expect(res.body.data[0].seedName).toBe(`${SEED_PREFIX}Epsilon Squash`);
      expect(res.body.data[0].submitterName).toBeNull();
    });

    it('resolved tab lists only resolved items', async () => {
      const res = await adminAgent.get('/api/admin/moderation?tab=resolved');
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(1);
      expect(res.body.data[0].status).toBe('approved');
    });

    it('detail includes the seed and a null submitter when submitted_by is null', async () => {
      const res = await adminAgent.get(`/api/admin/moderation/${anonCorrectionId}`);
      expect(res.status).toBe(200);
      expect(res.body.seedName).toBe(`${SEED_PREFIX}Epsilon Squash`);
      expect(res.body.seed).toEqual({
        id: cambiumSeedId,
        commonName: `${SEED_PREFIX}Epsilon Squash`,
        scientificName: null,
      });
      expect(res.body.submitter).toBeNull();
      expect(res.body.content.correctionText).toBe('Spacing is wrong');
    });

    it('defer sets under_review and leaves resolvedAt null', async () => {
      const id = await insertModerationItem({ type: 'correction', cambiumSeedId });
      const res = await adminAgent
        .patch(`/api/admin/moderation/${id}`)
        .send({ action: 'defer', note: 'ignored' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('under_review');
      expect(res.body.resolvedAt).toBeNull();
      expect(res.body.resolutionNote).toBeNull();
    });

    it('approve without a note succeeds and sets resolvedAt', async () => {
      const res = await adminAgent
        .patch(`/api/admin/moderation/${anonCorrectionId}`)
        .send({ action: 'approve' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('approved');
      expect(res.body.resolutionNote).toBeNull();
      expect(res.body.resolvedAt).not.toBeNull();
    });

    it('returns 409 for any action on a resolved item', async () => {
      for (const action of ['approve', 'reject', 'defer']) {
        const res = await adminAgent
          .patch(`/api/admin/moderation/${anonCorrectionId}`)
          .send({ action });
        expect(res.status).toBe(409);
        expect(res.body).toEqual({ error: 'This item is already resolved.' });
      }
    });

    it('approving a new_seed item marks the seed approved', async () => {
      const seedId = await insertPersonalSeed(userId, 'Zeta Carrot');
      const itemId = await insertModerationItem({
        type: 'new_seed',
        seedId,
        submittedBy: userId,
        content: { commonName: 'Zeta Carrot' },
      });
      const res = await adminAgent
        .patch(`/api/admin/moderation/${itemId}`)
        .send({ action: 'approve', note: '  Looks good  ' });
      expect(res.status).toBe(200);
      expect(res.body.resolutionNote).toBe('Looks good');

      const { rows } = await pool.query('SELECT contribution_status FROM seeds WHERE id = $1', [
        seedId,
      ]);
      expect(rows[0].contribution_status).toBe('approved');
    });

    it('rejecting a new_seed item marks the seed rejected', async () => {
      const seedId = await insertPersonalSeed(userId, 'Eta Beet');
      const itemId = await insertModerationItem({
        type: 'new_seed',
        seedId,
        submittedBy: userId,
        content: { commonName: 'Eta Beet' },
      });

      const detail = await adminAgent.get(`/api/admin/moderation/${itemId}`);
      expect(detail.body.seedName).toBe('Eta Beet');
      expect(detail.body.seed).toEqual(
        expect.objectContaining({ id: seedId, contributionStatus: 'pending' }),
      );
      expect(detail.body.submitter).toEqual(
        expect.objectContaining({ id: userId, email: USER_EMAIL }),
      );

      const res = await adminAgent
        .patch(`/api/admin/moderation/${itemId}`)
        .send({ action: 'reject' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('rejected');

      const { rows } = await pool.query('SELECT contribution_status FROM seeds WHERE id = $1', [
        seedId,
      ]);
      expect(rows[0].contribution_status).toBe('rejected');
    });

    it('rejects an unknown action and an over-long note with 400', async () => {
      const id = await insertModerationItem({ type: 'correction', cambiumSeedId });
      const bad = await adminAgent.patch(`/api/admin/moderation/${id}`).send({ action: 'delete' });
      expect(bad.status).toBe(400);
      const long = await adminAgent
        .patch(`/api/admin/moderation/${id}`)
        .send({ action: 'approve', note: 'x'.repeat(2001) });
      expect(long.status).toBe(400);
    });

    it('returns 404 for a nonexistent item', async () => {
      const res = await adminAgent.patch('/api/admin/moderation/99999').send({ action: 'approve' });
      expect(res.status).toBe(404);
    });
  });

  // ── Users ───────────────────────────────────────────────────────────────────

  describe('users', () => {
    it('summary separates paid, lifetime and supporters (including NULL interval)', async () => {
      const before = await adminAgent.get('/api/admin/users/summary');
      expect(before.status).toBe(200);

      const monthly = await createUser('sub-monthly@example.com');
      const lifetime = await createUser('sub-lifetime@example.com');
      const comped = await createUser('sub-comped@example.com');
      const setTier = (id: number, interval: string | null) =>
        pool.query(
          `UPDATE accounts SET subscription_tier = 'supporter', subscription_interval = $1 WHERE id = $2`,
          [interval, id],
        );
      await setTier(monthly, 'monthly');
      await setTier(lifetime, 'lifetime');
      await setTier(comped, null);

      const after = await adminAgent.get('/api/admin/users/summary');
      expect(after.body.paidSubscribers - before.body.paidSubscribers).toBe(1);
      expect(after.body.lifetime - before.body.lifetime).toBe(1);
      expect(after.body.supporters - before.body.supporters).toBe(3);
      expect(after.body.totalUsers - before.body.totalUsers).toBe(3);
    });

    it('charts for range=30d return one entry per day with no gaps and non-decreasing totals', async () => {
      const res = await adminAgent.get('/api/admin/users/charts?range=30d');
      expect(res.status).toBe(200);
      expect(res.body.range).toBe('30d');
      const growth: { bucket: string; totalUsers: number }[] = res.body.userGrowth;
      expect(growth).toHaveLength(30);
      for (let i = 1; i < growth.length; i++) {
        const prev = Date.parse(`${growth[i - 1].bucket}T00:00:00Z`);
        const cur = Date.parse(`${growth[i].bucket}T00:00:00Z`);
        expect(cur - prev).toBe(86_400_000);
        expect(growth[i].totalUsers).toBeGreaterThanOrEqual(growth[i - 1].totalUsers);
      }
      const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM accounts');
      expect(growth[growth.length - 1].totalUsers).toBe(rows[0].n);
      expect(res.body.tierBySignupMonth.length).toBeGreaterThan(0);
    });

    it('charts for range=all bucket by week', async () => {
      const res = await adminAgent.get('/api/admin/users/charts?range=all');
      expect(res.status).toBe(200);
      expect(res.body.userGrowth.length).toBeGreaterThan(0);
    });

    it('upgradeRate30d is null when there are no signups in the window', async () => {
      await pool.query(`UPDATE accounts SET created_at = now() - interval '60 days'`);
      try {
        const res = await adminAgent.get('/api/admin/users/summary');
        expect(res.status).toBe(200);
        expect(res.body.newSignups30d).toBe(0);
        expect(res.body.upgradeRate30d).toBeNull();
      } finally {
        await pool.query('UPDATE accounts SET created_at = now()');
      }
    });
  });

  // ── Features ────────────────────────────────────────────────────────────────

  describe('features', () => {
    it('lists every EVENT_KEYS entry zero-filled when usage_events is empty', async () => {
      await pool.query('TRUNCATE usage_events RESTART IDENTITY');
      const res = await adminAgent.get('/api/admin/features');
      expect(res.status).toBe(200);
      expect(res.body.features).toHaveLength(EVENT_KEYS.length);
      const keys = res.body.features.map((f: { key: string }) => f.key).sort();
      expect(keys).toEqual(EVENT_KEYS.map((e) => e.key).sort());
      expect(
        res.body.features.every(
          (f: { uses: number; users: number; pctOfActive: number }) =>
            f.uses === 0 && f.users === 0 && f.pctOfActive === 0,
        ),
      ).toBe(true);
    });

    it('reports uses and users per key from seeded events', async () => {
      const userId = await regularUserId();
      await pool.query(
        `INSERT INTO usage_events (user_id, session_id, event_key) VALUES
           ($1, 's1', 'canvas_plant_placed'),
           ($1, 's1', 'canvas_plant_placed'),
           ($2, 's2', 'canvas_plant_placed'),
           (NULL, 'g1', 'canvas_plant_placed'),
           ($1, 's1', 'not_a_real_key')`,
        [userId, adminId],
      );

      const res = await adminAgent.get('/api/admin/features');
      const row = res.body.features.find((f: { key: string }) => f.key === 'canvas_plant_placed');
      expect(row.uses).toBe(4);
      expect(row.users).toBe(2);
      expect(res.body.features).toHaveLength(EVENT_KEYS.length);
      expect(res.body.headline.canvasSessions).toBe(3);
    });

    it('micro-feedback responseRate is null for a trigger never fired', async () => {
      await pool.query('UPDATE accounts SET mf_data_export = false');
      const res = await adminAgent.get('/api/admin/features');
      const row = res.body.microFeedback.find(
        (m: { triggerKey: string }) => m.triggerKey === 'data_export',
      );
      expect(row.timesFired).toBe(0);
      expect(row.responseRate).toBeNull();
    });
  });

  // ── Feedback ────────────────────────────────────────────────────────────────

  describe('feedback', () => {
    let newId: number;
    let reviewedId: number;
    let closedId: number;

    beforeAll(async () => {
      await pool.query('TRUNCATE feedback_submissions RESTART IDENTITY');
      // The reviewed row is newer, but new rows still sort ahead of it.
      newId = await insertFeedback('new', 60);
      reviewedId = await insertFeedback('reviewed', 1);
      closedId = await insertFeedback('closed', 5);
    });

    it('default status excludes closed rows; status=everything includes them', async () => {
      const active = await adminAgent.get('/api/admin/feedback');
      expect(active.status).toBe(200);
      expect(active.body.data.map((f: { id: number }) => f.id)).not.toContain(closedId);
      expect(active.body.counts).toEqual({ new: 1, reviewed: 1, closed: 1 });
      expect(active.body.surfaces).toEqual(['canvas']);

      const all = await adminAgent.get('/api/admin/feedback?status=everything');
      expect(all.body.data.map((f: { id: number }) => f.id)).toContain(closedId);
      expect(all.body.total).toBe(3);
    });

    it('sorts new rows ahead of reviewed rows', async () => {
      const res = await adminAgent.get('/api/admin/feedback');
      expect(res.body.data.map((f: { id: number }) => f.id)).toEqual([newId, reviewedId]);
    });

    it('restores a closed row to reviewed', async () => {
      const res = await adminAgent
        .patch(`/api/admin/feedback/${closedId}`)
        .send({ status: 'reviewed' });
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(closedId);
      expect(res.body.status).toBe('reviewed');
    });

    it('bulk update rejects 101 ids and returns the updated ids for a valid list', async () => {
      const tooMany = Array.from({ length: 101 }, (_, i) => i + 1);
      const bad = await adminAgent
        .patch('/api/admin/feedback/bulk')
        .send({ ids: tooMany, status: 'closed' });
      expect(bad.status).toBe(400);

      const res = await adminAgent
        .patch('/api/admin/feedback/bulk')
        .send({ ids: [newId, reviewedId, 99999], status: 'closed' });
      expect(res.status).toBe(200);
      expect(res.body.updated).toEqual([newId, reviewedId].sort((a, b) => a - b));
    });

    it('returns 400 for category=idea', async () => {
      const res = await adminAgent.get('/api/admin/feedback?category=idea');
      expect(res.status).toBe(400);
    });

    it('returns 400 for an inherited-key status value', async () => {
      const res = await adminAgent.get('/api/admin/feedback?status=toString');
      expect(res.status).toBe(400);
    });
  });

  // ── System ──────────────────────────────────────────────────────────────────

  describe('system', () => {
    beforeAll(async () => {
      await pool.query('TRUNCATE job_runs RESTART IDENTITY');
    });

    it('reports database ok and a nightly job in state never when job_runs is empty', async () => {
      const res = await adminAgent.get('/api/admin/system');
      expect(res.status).toBe(200);
      expect(typeof res.body.status).toBe('string');
      expect(res.body.database.ok).toBe(true);
      const nightly = res.body.jobs.find((j: { jobKey: string }) => j.jobKey === 'nightly');
      expect(nightly).toEqual(
        expect.objectContaining({ state: 'never', label: 'Nightly maintenance' }),
      );
      expect(res.body.requestMetrics).toHaveProperty('hours');
      expect(res.body.sentry).toHaveProperty('issuesUrl');
    });

    it('reports degraded when the latest nightly run failed', async () => {
      await pool.query(
        `INSERT INTO job_runs (job_key, status, started_at, finished_at, error_msg) VALUES
           ('nightly', 'ok',     now() - interval '25 hours', now() - interval '25 hours', NULL),
           ('nightly', 'failed', now() - interval '1 hour',   now() - interval '1 hour',   'boom')`,
      );
      const res = await adminAgent.get('/api/admin/system');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('degraded');
      const nightly = res.body.jobs.find((j: { jobKey: string }) => j.jobKey === 'nightly');
      expect(nightly.state).toBe('failed');
      expect(nightly.errorMsg).toBe('boom');
    });
  });
});

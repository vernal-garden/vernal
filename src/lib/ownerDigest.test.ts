import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import * as mailer from './mailer';
import { logger } from './logger';
import { db } from './db';

vi.mock('./mailer', () => ({ sendMail: vi.fn().mockResolvedValue(undefined) }));
const sendMailMock = vi.mocked(mailer.sendMail);

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL must be set to run tests');
const pool = new Pool({ connectionString: url });

const APP = 'https://app.example.test';
const PREFIX = '_digest_p64_';
const HOUR = 60 * 60 * 1000;

// 08:00 Pacific on Wednesday 2026-11-11 (PST), after the default hour of 7. The timing tests also use
// 06:00 Pacific that day (before the hour) and 07:30 (an earlier send on the same Pacific date).
const NOW = new Date('2026-11-11T16:00:00Z');
const YESTERDAY = new Date('2026-11-10T16:00:00Z');

type DigestModule = typeof import('./ownerDigest');
let runOwnerDigest: DigestModule['runOwnerDigest'];

async function setMarker(d: Date | null): Promise<void> {
  await pool.query('UPDATE owner_digest_state SET last_sent_at = $1 WHERE id = 1', [d]);
}

async function getMarker(): Promise<Date | null> {
  const { rows } = await pool.query<{ last_sent_at: Date | null }>(
    'SELECT last_sent_at FROM owner_digest_state WHERE id = 1',
  );
  return rows[0].last_sent_at;
}

async function addEvent(kind: string, at: Date, times = 1): Promise<void> {
  for (let i = 0; i < times; i++) {
    await pool.query('INSERT INTO owner_events (kind, occurred_at) VALUES ($1, $2)', [kind, at]);
  }
}

async function addAccount(
  tag: string,
  tier: 'free' | 'supporter' = 'free',
  interval: 'monthly' | 'annual' | 'lifetime' | null = null,
): Promise<string> {
  const email = `${PREFIX}${tag}@vernal-test.internal`;
  await pool.query(
    `INSERT INTO accounts (email, password_hash, zone, zone_location_label, subscription_tier, subscription_interval)
     VALUES ($1, 'x', '7b', 'Test City', $2, $3)`,
    [email, tier, interval],
  );
  return email;
}

async function addModeration(type: 'correction' | 'new_seed', status = 'new'): Promise<void> {
  await pool.query(
    `INSERT INTO moderation_items (type, status, content) VALUES ($1, $2, '{"tag":"digest-test"}')`,
    [type, status],
  );
}

// Accounts already in the shared test DB count too, so expectations are built on this.
async function baseline() {
  const { rows } = await pool.query<{ total: number; monthly: number; annual: number; lifetime: number }>(`
    SELECT COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE subscription_tier = 'supporter' AND subscription_interval = 'monthly')::int AS monthly,
      COUNT(*) FILTER (WHERE subscription_tier = 'supporter' AND subscription_interval = 'annual')::int AS annual,
      COUNT(*) FILTER (WHERE subscription_tier = 'supporter' AND subscription_interval = 'lifetime')::int AS lifetime
    FROM accounts`);
  return rows[0];
}

async function cleanup(): Promise<void> {
  await pool.query('TRUNCATE owner_events RESTART IDENTITY');
  await pool.query(`DELETE FROM moderation_items WHERE content->>'tag' = 'digest-test'`);
  await pool.query('DELETE FROM accounts WHERE email LIKE $1', [`${PREFIX}%`]);
  await setMarker(null);
}

const ENV_KEYS = ['ALERT_EMAIL_TO', 'FRONTEND_URL', 'ALERT_DIGEST_HOUR'] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

beforeAll(async () => {
  vi.stubEnv('ALERT_DIGEST_HOUR', '');
  ({ runOwnerDigest } = await import('./ownerDigest'));
  vi.unstubAllEnvs();
  await cleanup();
  await pool.query('TRUNCATE moderation_items RESTART IDENTITY');
});

afterAll(async () => {
  await cleanup();
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
  await pool.end();
  await db.end();
});

beforeEach(async () => {
  sendMailMock.mockReset();
  sendMailMock.mockResolvedValue(undefined);
  vi.stubEnv('ALERT_EMAIL_TO', 'owner@example.test');
  vi.stubEnv('FRONTEND_URL', APP);
  await cleanup();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('runOwnerDigest timing', () => {
  it('skips before the digest hour and leaves the marker alone', async () => {
    await setMarker(YESTERDAY);
    await addEvent('account_created', new Date(NOW.getTime() - HOUR));
    expect(await runOwnerDigest(new Date('2026-11-11T14:00:00Z'))).toBe('skipped'); // 06:00 Pacific
    expect(sendMailMock).not.toHaveBeenCalled();
    expect((await getMarker())?.getTime()).toBe(YESTERDAY.getTime());
  });

  it('skips when the last send was on the same Pacific date', async () => {
    const sentEarlier = new Date('2026-11-11T15:30:00Z'); // 07:30 Pacific
    await setMarker(sentEarlier);
    await addEvent('account_created', NOW);
    expect(await runOwnerDigest(NOW)).toBe('skipped');
    expect(sendMailMock).not.toHaveBeenCalled();
    expect((await getMarker())?.getTime()).toBe(sentEarlier.getTime());
  });

  it('sends again the next day, with the window starting at the previous send', async () => {
    await setMarker(YESTERDAY);
    await addEvent('account_created', new Date(NOW.getTime() - HOUR));
    expect(await runOwnerDigest(NOW)).toBe('sent');
    expect(sendMailMock).toHaveBeenCalledTimes(1);

    const next = new Date('2026-11-12T16:00:00Z');
    await addEvent('account_created', new Date(NOW.getTime() - HOUR)); // before the marker: not counted again
    await addEvent('account_created', new Date(NOW.getTime() + HOUR), 2);
    expect(await runOwnerDigest(next)).toBe('sent');
    expect(sendMailMock).toHaveBeenCalledTimes(2);
    expect(sendMailMock.mock.calls[1][0].subject).toBe('[Vernal app] Daily summary for Thursday, November 12');
    expect(sendMailMock.mock.calls[1][0].text).toMatch(/^Accounts: 2 new\./);
    expect((await getMarker())?.getTime()).toBe(next.getTime());
  });

  it('uses the last 24 hours on the first run', async () => {
    await addEvent('refund', new Date(NOW.getTime() - 23 * HOUR));
    await addEvent('refund', new Date(NOW.getTime() - 25 * HOUR), 5);
    expect(await runOwnerDigest(NOW)).toBe('sent');
    expect(sendMailMock.mock.calls[0][0].text).toBe(
      `Refunds and disputes: 1 refund, 0 disputes. — ${APP}/admin/users`,
    );
    expect((await getMarker())?.getTime()).toBe(NOW.getTime());
  });
});

describe('runOwnerDigest content', () => {
  it('sends the counts, exact lines and links', async () => {
    await setMarker(YESTERDAY);
    const b = await baseline();
    await addAccount('free');
    await addAccount('m1', 'supporter', 'monthly');
    await addAccount('m2', 'supporter', 'monthly');
    await addAccount('a1', 'supporter', 'annual');
    await addAccount('l1', 'supporter', 'lifetime');
    await addModeration('correction');
    await addModeration('correction', 'under_review');
    await addModeration('correction', 'approved');
    await addModeration('new_seed');
    await addModeration('new_seed', 'rejected');

    const inside = new Date(NOW.getTime() - HOUR);
    await addEvent('account_created', inside, 2);
    await addEvent('deletion_scheduled', inside);
    await addEvent('subscription_started', inside);
    await addEvent('subscription_cancelled', inside);
    await addEvent('dispute', inside);
    await addEvent('beta_terms_accepted', inside, 3);
    await addEvent('takeover', inside);
    // Outside the window: at the previous send (exclusive), before it, and after now.
    await addEvent('account_created', YESTERDAY);
    await addEvent('not_me', new Date(YESTERDAY.getTime() - HOUR), 4);
    await addEvent('lifetime_purchased', new Date(NOW.getTime() + HOUR), 4);

    expect(await runOwnerDigest(NOW)).toBe('sent');
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const mail = sendMailMock.mock.calls[0][0];
    expect(mail.to).toBe('owner@example.test');
    expect(mail.subject).toBe('[Vernal app] Daily summary for Wednesday, November 11');

    const rows: Array<[string, string]> = [
      [`Accounts: 2 new. ${b.total + 5} total.`, '/admin/users'],
      ['Deletions: 1 scheduled, 0 cancelled.', '/admin/users'],
      [
        `Supporters: 1 new, 0 lifetime, 1 cancelled. Now ${b.monthly + 2} monthly, ${b.annual + 1} yearly, ${b.lifetime + 1} lifetime.`,
        '/admin/users',
      ],
      ['Refunds and disputes: 0 refunds, 1 dispute.', '/admin/users'],
      ['Beta terms accepted: 3.', '/admin/beta'],
      ['Takeovers: 1. Not-me reports: 0.', '/admin/users'],
      ['Waiting for review: 2 corrections, 1 new seed.', '/admin/moderation'],
    ];
    expect(mail.text).toBe(rows.map(([t, p]) => `${t} — ${APP}${p}`).join('\n\n'));
    for (const [t, p] of rows) {
      expect(mail.html).toContain(`<p>${t} <a href="${APP}${p}">`);
    }
  });

  it('is empty when nothing happened and nothing is waiting, and still moves the marker', async () => {
    await setMarker(YESTERDAY);
    await addEvent('account_created', new Date(YESTERDAY.getTime() - HOUR));
    expect(await runOwnerDigest(NOW)).toBe('empty');
    expect(sendMailMock).not.toHaveBeenCalled();
    expect((await getMarker())?.getTime()).toBe(NOW.getTime());
  });

  it('sends for open moderation items alone', async () => {
    await setMarker(YESTERDAY);
    await addModeration('correction', 'under_review');
    expect(await runOwnerDigest(NOW)).toBe('sent');
    expect(sendMailMock.mock.calls[0][0].text).toBe(
      `Waiting for review: 1 correction, 0 new seeds. — ${APP}/admin/moderation`,
    );
  });

  it('leaves out groups with no events in the window', async () => {
    await setMarker(YESTERDAY);
    await addEvent('not_me', new Date(NOW.getTime() - HOUR));
    await runOwnerDigest(NOW);
    expect(sendMailMock.mock.calls[0][0].text).toBe(
      `Takeovers: 0. Not-me reports: 1. — ${APP}/admin/users`,
    );
  });

  it('puts no account email in the mail', async () => {
    await setMarker(YESTERDAY);
    const emails = [
      await addAccount('priv1', 'supporter', 'monthly'),
      await addAccount('priv2', 'supporter', 'lifetime'),
    ];
    await addEvent('account_created', new Date(NOW.getTime() - HOUR), 2);
    await addEvent('subscription_started', new Date(NOW.getTime() - HOUR));
    expect(await runOwnerDigest(NOW)).toBe('sent');
    const sent = JSON.stringify(sendMailMock.mock.calls);
    for (const e of emails) expect(sent).not.toContain(e);
    expect(sent).not.toContain(PREFIX);
  });
});

describe('runOwnerDigest sending', () => {
  it('sends once when two runs race', async () => {
    await setMarker(YESTERDAY);
    await addEvent('account_created', new Date(NOW.getTime() - HOUR));
    const results = await Promise.all([runOwnerDigest(NOW), runOwnerDigest(NOW)]);
    expect([...results].sort()).toEqual(['sent', 'skipped']);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
  });

  it('skips when another run moves the marker between the read and the claim', async () => {
    await setMarker(YESTERDAY);
    await addEvent('account_created', new Date(NOW.getTime() - HOUR));
    const stolen = new Date(NOW.getTime() - 1);
    const realQuery = db.query.bind(db) as (...a: unknown[]) => Promise<unknown>;
    let moved = false;
    vi.spyOn(db, 'query').mockImplementation((async (...args: unknown[]) => {
      if (!moved && typeof args[0] === 'string' && args[0].includes('UPDATE owner_digest_state')) {
        moved = true;
        await setMarker(stolen);
      }
      return realQuery(...args);
    }) as never);

    expect(await runOwnerDigest(NOW)).toBe('skipped');
    expect(moved).toBe(true);
    expect(sendMailMock).not.toHaveBeenCalled();
    expect((await getMarker())?.getTime()).toBe(stolen.getTime());
  });

  it('leaves the marker moved when the send fails', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    sendMailMock.mockRejectedValue(new Error('SMTP down'));
    await setMarker(YESTERDAY);
    await addEvent('account_created', new Date(NOW.getTime() - HOUR));
    expect(await runOwnerDigest(NOW)).toBe('sent');
    expect(warn).toHaveBeenCalledWith('Owner alert failed', expect.objectContaining({ kind: 'owner_digest' }));
    expect((await getMarker())?.getTime()).toBe(NOW.getTime());
    expect(await runOwnerDigest(new Date(NOW.getTime() + HOUR))).toBe('skipped');
  });
});

describe('ALERT_DIGEST_HOUR', () => {
  afterEach(() => vi.resetModules());

  it.each(['24', 'abc', '7.5', '-1', '100'])('throws at import for %s, naming the setting', async (bad) => {
    vi.resetModules();
    vi.stubEnv('ALERT_DIGEST_HOUR', bad);
    await expect(import('./ownerDigest')).rejects.toThrow(/ALERT_DIGEST_HOUR/);
  });

  it('changes the hour the digest waits for', async () => {
    await setMarker(YESTERDAY);
    // 08:00 Pacific: the default hour (7) has passed, 10 has not, 8 has.
    vi.resetModules();
    vi.stubEnv('ALERT_DIGEST_HOUR', '10');
    const late = await import('./ownerDigest');
    expect(await late.runOwnerDigest(NOW)).toBe('skipped');
    expect((await getMarker())?.getTime()).toBe(YESTERDAY.getTime());
    await (await import('./db')).db.end(); // each import gets its own pool

    vi.resetModules();
    vi.stubEnv('ALERT_DIGEST_HOUR', '8');
    const exact = await import('./ownerDigest');
    expect(await exact.runOwnerDigest(NOW)).toBe('empty');
    expect((await getMarker())?.getTime()).toBe(NOW.getTime());
    await (await import('./db')).db.end();
  });
});

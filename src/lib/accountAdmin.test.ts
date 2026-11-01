import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import bcrypt from 'bcrypt';
import { Pool, type PoolClient } from 'pg';
import * as mailer from './mailer';
import { parseArgs, setEmail, setPassword, setRole, NO_ACCOUNT_MESSAGE } from './accountAdmin';

vi.mock('./mailer', () => ({ sendMail: vi.fn().mockResolvedValue(undefined) }));
const sendMailMock = vi.mocked(mailer.sendMail);

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL must be set to run tests');

const pool = new Pool({ connectionString: url });
let client: PoolClient;

async function createAccount(email: string, extra: { verified?: boolean; pending?: string } = {}): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO accounts (email, password_hash, zone, zone_location_label, email_verified, pending_email)
     VALUES ($1, 'old-hash', '7b', 'Test City', $2, $3)
     RETURNING id`,
    [email, extra.verified ?? false, extra.pending ?? null],
  );
  return rows[0].id;
}

async function accountRow(id: number) {
  const { rows } = await pool.query(
    'SELECT email, email_verified, pending_email, role, password_hash FROM accounts WHERE id = $1',
    [id],
  );
  return rows[0];
}

const TOKEN_TABLES = [
  'password_reset_tokens',
  'email_change_tokens',
  'email_revert_tokens',
  'email_verification_tokens',
] as const;

const TRUNCATE_ALL =
  'TRUNCATE accounts, guest_sessions, password_reset_tokens, email_change_tokens, email_revert_tokens, email_verification_tokens RESTART IDENTITY CASCADE';

async function tokenCount(accountId: number): Promise<number> {
  let total = 0;
  for (const t of TOKEN_TABLES) {
    const { rows } = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${t} WHERE account_id = $1`, [accountId]);
    total += Number(rows[0].n);
  }
  return total;
}

async function liveSessions(accountId: number): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    'SELECT count(*) AS n FROM guest_sessions WHERE account_id = $1 AND expires_at > now()',
    [accountId],
  );
  return Number(rows[0].n);
}

async function seedTokens(accountId: number): Promise<void> {
  const exp = "now() + interval '1 hour'";
  await pool.query(`INSERT INTO password_reset_tokens (account_id, token_hash, expires_at) VALUES ($1, 'seed-pr', ${exp})`, [accountId]);
  await pool.query(
    `INSERT INTO email_change_tokens (account_id, token_hash, new_email, expires_at) VALUES ($1, 'seed-ec', 'n@x.io', ${exp})`,
    [accountId],
  );
  await pool.query(
    `INSERT INTO email_revert_tokens (account_id, token_hash, old_email, new_email, expires_at) VALUES ($1, 'seed-er', 'o@x.io', 'n@x.io', ${exp})`,
    [accountId],
  );
  await pool.query(
    `INSERT INTO email_verification_tokens (account_id, email, token_hash, expires_at) VALUES ($1, 'o@x.io', 'seed-ev', ${exp})`,
    [accountId],
  );
  await pool.query(
    `INSERT INTO guest_sessions (token_hash, account_id, expires_at) VALUES ('seed-sess', $1, ${exp})`,
    [accountId],
  );
}

beforeAll(async () => {
  client = await pool.connect();
  await pool.query(TRUNCATE_ALL);
});

beforeEach(async () => {
  await pool.query(TRUNCATE_ALL);
  sendMailMock.mockClear();
});

afterAll(async () => {
  client.release();
  await pool.end();
});

describe('parseArgs', () => {
  it('parses set-password and lowercases the email', () => {
    expect(parseArgs(['set-password', ' Jane@Example.com '])).toEqual({
      ok: true,
      command: { kind: 'set-password', email: 'jane@example.com' },
    });
  });

  it('parses set-email with both addresses lowercased', () => {
    expect(parseArgs(['set-email', 'A@x.io', 'B@X.io'])).toEqual({
      ok: true,
      command: { kind: 'set-email', current: 'a@x.io', next: 'b@x.io' },
    });
  });

  it('parses set-role', () => {
    expect(parseArgs(['set-role', 'a@x.io', 'admin'])).toEqual({
      ok: true,
      command: { kind: 'set-role', email: 'a@x.io', role: 'admin' },
    });
  });

  it('rejects a bad role, wrong arity, unknown and missing commands', () => {
    expect(parseArgs(['set-role', 'a@x.io', 'boss']).ok).toBe(false);
    expect(parseArgs(['set-role', 'a@x.io']).ok).toBe(false);
    expect(parseArgs(['set-password']).ok).toBe(false);
    expect(parseArgs(['set-password', 'a@x.io', 'extra']).ok).toBe(false);
    expect(parseArgs(['set-email', 'a@x.io']).ok).toBe(false);
    expect(parseArgs(['nope']).ok).toBe(false);
    expect(parseArgs([]).ok).toBe(false);
  });
});

describe('setEmail', () => {
  it('sets the email, verifies it and clears the pending change', async () => {
    const id = await createAccount('old@x.io', { pending: 'pending@x.io' });
    expect(await setEmail(client, 'OLD@x.io', 'New@X.io')).toEqual({ ok: true });
    expect(await accountRow(id)).toMatchObject({
      email: 'new@x.io',
      email_verified: true,
      pending_email: null,
    });
  });

  it('refuses an address that belongs to another account', async () => {
    const id = await createAccount('a@x.io');
    await createAccount('b@x.io');
    const result = await setEmail(client, 'a@x.io', 'B@x.io');
    expect(result.ok).toBe(false);
    expect((await accountRow(id)).email).toBe('a@x.io');
  });

  it('reports a missing account', async () => {
    expect(await setEmail(client, 'ghost@x.io', 'new@x.io')).toEqual({ ok: false, error: NO_ACCOUNT_MESSAGE });
  });
});

describe('setEmail hardening', () => {
  it('rejects an invalid new address', async () => {
    const id = await createAccount('old@example.com');
    const result = await setEmail(client, 'old@example.com', 'x@y.com, z@evil.com');
    expect(result.ok).toBe(false);
    expect((await accountRow(id)).email).toBe('old@example.com');
  });

  it("refuses another account's pending address", async () => {
    await createAccount('other@example.com', { pending: 'wanted@example.com' });
    await createAccount('old@example.com');
    const result = await setEmail(client, 'old@example.com', 'wanted@example.com');
    expect(result).toEqual({ ok: false, error: 'That email belongs to another account.' });
  });

  it('deletes outstanding tokens and signs out every device', async () => {
    const id = await createAccount('old@example.com');
    await seedTokens(id);
    expect(await setEmail(client, 'old@example.com', 'new@example.com')).toEqual({ ok: true });
    expect(await tokenCount(id)).toBe(0);
    expect(await liveSessions(id)).toBe(0);
  });
});

describe('setPassword hardening', () => {
  it('deletes outstanding tokens', async () => {
    const id = await createAccount('user@example.com');
    await seedTokens(id);
    expect(await setPassword(client, 'user@example.com', 'a-new-password')).toEqual({ ok: true });
    expect(await tokenCount(id)).toBe(0);
  });
});

describe('setRole', () => {
  it('changes the role', async () => {
    const id = await createAccount('a@x.io');
    expect(await setRole(client, 'A@x.io', 'admin')).toEqual({ ok: true });
    expect((await accountRow(id)).role).toBe('admin');
    expect(await setRole(client, 'a@x.io', 'user')).toEqual({ ok: true });
    expect((await accountRow(id)).role).toBe('user');
  });

  it('reports a missing account', async () => {
    expect(await setRole(client, 'ghost@x.io', 'admin')).toEqual({ ok: false, error: NO_ACCOUNT_MESSAGE });
  });
});

describe('setPassword', () => {
  it('hashes the password, signs out every session and sends the notice', async () => {
    const id = await createAccount('a@x.io');
    await pool.query(
      `INSERT INTO guest_sessions (token_hash, account_id, expires_at)
       VALUES ('tok-1', $1, now() + interval '7 days')`,
      [id],
    );
    expect(await setPassword(client, 'A@x.io', 'new-password-1')).toEqual({ ok: true });

    const row = await accountRow(id);
    expect(await bcrypt.compare('new-password-1', row.password_hash)).toBe(true);
    const { rows } = await pool.query('SELECT expires_at <= now() AS expired FROM guest_sessions WHERE account_id = $1', [id]);
    expect(rows[0].expired).toBe(true);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(sendMailMock.mock.calls[0][0].to).toBe('a@x.io');
  });

  it('refuses a short password and leaves the account alone', async () => {
    const id = await createAccount('a@x.io');
    const result = await setPassword(client, 'a@x.io', 'short');
    expect(result.ok).toBe(false);
    expect((await accountRow(id)).password_hash).toBe('old-hash');
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it('reports a missing account without sending mail', async () => {
    expect(await setPassword(client, 'ghost@x.io', 'long-enough-1')).toEqual({ ok: false, error: NO_ACCOUNT_MESSAGE });
    expect(sendMailMock).not.toHaveBeenCalled();
  });
});

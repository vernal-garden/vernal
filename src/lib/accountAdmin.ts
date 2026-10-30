import bcrypt from 'bcrypt';
import type { PoolClient } from 'pg';
import { sendPasswordChangedNotice } from './accountSecurity';
import { revokeAccountSessions } from './sessions';

// Logic behind `npm run account`: operator-side account fixes for servers that
// run without mail (no password-reset or email-change links). The CLI itself
// lives in scripts/account.ts.

export const MIN_PASSWORD_LENGTH = 8;
export const NO_ACCOUNT_MESSAGE = 'No account with that email.';

export const USAGE = `Usage:
  npm run account -- set-password <email>
  npm run account -- set-email <current-email> <new-email>
  npm run account -- set-role <email> admin|user`;

export type Role = 'admin' | 'user';

export type Command =
  | { kind: 'set-password'; email: string }
  | { kind: 'set-email'; current: string; next: string }
  | { kind: 'set-role'; email: string; role: Role };

export type ParseResult = { ok: true; command: Command } | { ok: false; error: string };

export type ActionResult = { ok: true } | { ok: false; error: string };

const normalize = (email: string) => email.trim().toLowerCase();

// argv is the arguments after the script name.
export function parseArgs(argv: string[]): ParseResult {
  const [name, ...rest] = argv;
  const fail = (error: string): ParseResult => ({ ok: false, error });

  switch (name) {
    case 'set-password': {
      if (rest.length !== 1 || !normalize(rest[0])) return fail('set-password takes one email.');
      return { ok: true, command: { kind: 'set-password', email: normalize(rest[0]) } };
    }
    case 'set-email': {
      if (rest.length !== 2 || !normalize(rest[0]) || !normalize(rest[1])) {
        return fail('set-email takes the current email and the new email.');
      }
      return {
        ok: true,
        command: { kind: 'set-email', current: normalize(rest[0]), next: normalize(rest[1]) },
      };
    }
    case 'set-role': {
      if (rest.length !== 2 || !normalize(rest[0])) return fail('set-role takes an email and a role.');
      if (rest[1] !== 'admin' && rest[1] !== 'user') return fail('The role must be admin or user.');
      return { ok: true, command: { kind: 'set-role', email: normalize(rest[0]), role: rest[1] } };
    }
    case undefined:
      return fail('No command given.');
    default:
      return fail(`Unknown command: ${name}`);
  }
}

// Same parse as the routes: BCRYPT_ROUNDS, default 12.
function bcryptRounds(): number {
  return parseInt(process.env.BCRYPT_ROUNDS ?? '12', 10);
}

export async function setRole(client: PoolClient, emailInput: string, role: Role): Promise<ActionResult> {
  const { rowCount } = await client.query(
    'UPDATE accounts SET role = $1, updated_at = NOW() WHERE email = $2',
    [role, normalize(emailInput)],
  );
  return rowCount ? { ok: true } : { ok: false, error: NO_ACCOUNT_MESSAGE };
}

// Marks the new address verified and clears any pending change. Outstanding
// email_change_tokens are left alone: they only work from a link mailed to the
// address they name.
export async function setEmail(
  client: PoolClient,
  currentInput: string,
  nextInput: string,
): Promise<ActionResult> {
  const current = normalize(currentInput);
  const next = normalize(nextInput);

  const { rows } = await client.query<{ id: number }>('SELECT id FROM accounts WHERE email = $1', [current]);
  if (rows.length === 0) return { ok: false, error: NO_ACCOUNT_MESSAGE };

  const taken = await client.query('SELECT 1 FROM accounts WHERE email = $1 AND id <> $2', [next, rows[0].id]);
  if (taken.rows.length > 0) return { ok: false, error: 'That email belongs to another account.' };

  await client.query(
    'UPDATE accounts SET email = $1, email_verified = true, pending_email = NULL, updated_at = NOW() WHERE id = $2',
    [next, rows[0].id],
  );
  return { ok: true };
}

// Hashes, then looks the account up and updates it in one transaction, signing
// out every device. The notice goes out after the commit and skips itself when
// mail is off.
export async function setPassword(
  client: PoolClient,
  emailInput: string,
  password: string,
): Promise<ActionResult> {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  const email = normalize(emailInput);
  const hash = await bcrypt.hash(password, bcryptRounds());

  await client.query('BEGIN');
  try {
    const { rows } = await client.query<{ id: number }>(
      'SELECT id FROM accounts WHERE email = $1 FOR UPDATE',
      [email],
    );
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return { ok: false, error: NO_ACCOUNT_MESSAGE };
    }
    const accountId = Number(rows[0].id);
    await client.query('UPDATE accounts SET password_hash = $1, updated_at = NOW() WHERE id = $2', [
      hash,
      accountId,
    ]);
    await revokeAccountSessions(client, accountId);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  }

  await sendPasswordChangedNotice(email);
  return { ok: true };
}

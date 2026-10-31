import crypto from 'crypto';
import { db } from './db';
import type { Pool, PoolClient } from 'pg';
import type { SessionData, SessionAccount } from '../types';
import { hashToken } from './tokens';
import { effectiveTier } from './tier';
import { secureCookies } from './serverConfig';

const SESSION_DAYS = parseInt(process.env.SESSION_DAYS ?? '7', 10);
const GUEST_SESSION_DAYS = parseInt(process.env.GUEST_SESSION_DAYS ?? '30', 10);
const COOKIE_NAME = '_vernal_sid';

export { COOKIE_NAME };

// Generate a cryptographically random session token
function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

// HMAC-sign the token with SESSION_SECRET so we can detect tampered cookies
// without a DB lookup on every request (the DB lookup still happens to check expiry/revocation)
function signToken(token: string): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET is not set');
  const sig = crypto.createHmac('sha256', secret).update(token).digest('hex');
  return `${token}.${sig}`;
}

// `unknown` because cookie-parser can hand back non-strings (e.g. `j:1` → 1).
function verifyToken(signed: unknown): string | null {
  if (typeof signed !== 'string') return null;
  const parts = signed.split('.');
  if (parts.length !== 2) return null;
  const [token, sig] = parts;
  const expected = crypto.createHmac('sha256', process.env.SESSION_SECRET!).update(token).digest('hex');
  // timingSafeEqual throws on unequal byte lengths. Comparing string length isn't enough
  // (multi-byte chars), so only exactly 64 lowercase hex chars can be a valid signature.
  if (!/^[0-9a-f]{64}$/.test(sig)) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  return token;
}

// Exported wrapper — lets auth.ts check expired-but-HMAC-valid cookies without a DB lookup
export function verifySignedToken(signed: unknown): string | null {
  return verifyToken(signed);
}

export function makeSessionCookie(
  signedToken: string,
  expiresAt: Date,
  res: import('express').Response,
  cookieExpires?: Date,
): void {
  res.cookie(COOKIE_NAME, signedToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: secureCookies(),
    expires: cookieExpires ?? expiresAt,
    path: '/',
  });
}

export function clearSessionCookie(res: import('express').Response): void {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

// Create a new guest session row and return the signed cookie value
export async function createGuestSession(): Promise<{ signedToken: string; expiresAt: Date }> {
  const token = generateToken();
  const signedToken = signToken(token);
  const expiresAt = new Date(Date.now() + GUEST_SESSION_DAYS * 24 * 60 * 60 * 1000);

  await db.query(
    `INSERT INTO guest_sessions (token_hash, expires_at)
     VALUES ($1, $2)`,
    [hashToken(token), expiresAt],
  );

  return { signedToken, expiresAt };
}

type Runner = Pool | PoolClient;

// Attaches a session row to an account and replaces its token, so any copy of
// the pre-login cookie stops working (session fixation). The row id is kept on
// purpose: guest gardens/seeds reference guest_sessions(id) ON DELETE CASCADE
// and the merge prompt reads pending data by that id.
export async function rotateSessionToken(
  runner: Runner,
  oldTokenHash: string,
  accountId: number,
): Promise<{ signedToken: string; expiresAt: Date }> {
  const rotated = await updateSessionToken(runner, oldTokenHash, accountId, false);
  if (rotated) return rotated;
  // The cookie's row is gone, or belongs to another account — start a fresh session.
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  const token = generateToken();
  await runner.query(
    `INSERT INTO guest_sessions (token_hash, expires_at, account_id, migrated_at, authenticated_at)
     VALUES ($1, $2, $3, now(), now())`,
    [hashToken(token), expiresAt, accountId],
  );
  return { signedToken: signToken(token), expiresAt };
}

// As rotateSessionToken, but only for a row that is still live. Returns null
// (changing nothing) when the row is gone, expired or another account's, so a
// session revoked mid-request can't be revived with a fresh expiry.
export async function rotateLiveSessionToken(
  runner: Runner,
  oldTokenHash: string,
  accountId: number,
): Promise<{ signedToken: string; expiresAt: Date } | null> {
  return updateSessionToken(runner, oldTokenHash, accountId, true);
}

async function updateSessionToken(
  runner: Runner,
  oldTokenHash: string,
  accountId: number,
  requireLive: boolean,
): Promise<{ signedToken: string; expiresAt: Date } | null> {
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  const token = generateToken();
  const result = await runner.query(
    `UPDATE guest_sessions
        SET token_hash = $1, account_id = $2,
            migrated_at = COALESCE(migrated_at, now()), expires_at = $3,
            authenticated_at = now()
      WHERE token_hash = $4 AND (account_id IS NULL OR account_id = $2)
        ${requireLive ? 'AND expires_at > now()' : ''}`,
    [hashToken(token), accountId, expiresAt, oldTokenHash],
  );
  if (result.rowCount === 0) return null;
  return { signedToken: signToken(token), expiresAt };
}

// Expires an account's session rows (optionally sparing one). Rows are expired
// rather than deleted: findSession rejects expired rows, the GET /session cold
// path treats migrated rows as plain unauthenticated (a deleted row would read
// as 'gone'), and unmerged guest data is not cascaded away.
export async function revokeAccountSessions(
  runner: Runner,
  accountId: number,
  exceptTokenHash?: string,
): Promise<void> {
  if (exceptTokenHash) {
    await runner.query(
      'UPDATE guest_sessions SET expires_at = LEAST(expires_at, now()) WHERE account_id = $1 AND token_hash <> $2',
      [accountId, exceptTokenHash],
    );
  } else {
    await runner.query(
      'UPDATE guest_sessions SET expires_at = LEAST(expires_at, now()) WHERE account_id = $1',
      [accountId],
    );
  }
}

// Attach the current session (rotating its token) or create a new one for an account.
export async function claimSession(
  accountId: number,
  existingTokenHash: string | null,
  client?: PoolClient,
): Promise<{ signedToken: string; expiresAt: Date }> {
  const runner = client ?? db;

  if (existingTokenHash) {
    return rotateSessionToken(runner, existingTokenHash, accountId);
  }

  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  const token = generateToken();
  const signedToken = signToken(token);
  await runner.query(
    `INSERT INTO guest_sessions (token_hash, expires_at, account_id, migrated_at, authenticated_at)
     VALUES ($1, $2, $3, now(), now())`,
    [hashToken(token), expiresAt, accountId],
  );
  return { signedToken, expiresAt };
}

// Migrate guest gardens and seeds to an account — must be called inside a caller-owned transaction.
export async function migrateGuestData(
  client: PoolClient,
  sessionId: string,
  accountId: number,
): Promise<void> {
  await client.query(
    `UPDATE gardens SET owner_id = $1, guest_session_id = NULL WHERE guest_session_id = $2`,
    [accountId, sessionId],
  );
  await client.query(
    `UPDATE seeds SET owner_id = $1, guest_session_id = NULL WHERE guest_session_id = $2`,
    [accountId, sessionId],
  );
}

// Returns pending guest data for the merge-prompt UI. Guests may have at most one garden;
// if somehow multiple exist, returns the first by created_at and logs a warning.
export async function getPendingGuestData(
  sessionId: string,
): Promise<{ gardenName: string; bedCount: number; plantCount: number } | null> {
  // Counts are informational for the merge-prompt UI.
  // Beds and plantings belong to gardens via FK and migrate implicitly when
  // migrateGuestData updates the parent garden's owner_id.
  const { rows } = await db.query<{ name: string; bed_count: number; plant_count: number }>(
    `SELECT g.name,
       (SELECT COUNT(*) FROM beds      WHERE garden_id = g.id)::int AS bed_count,
       (SELECT COUNT(*) FROM plantings WHERE garden_id = g.id)::int AS plant_count
     FROM gardens g
     WHERE g.guest_session_id = $1
     ORDER BY g.created_at ASC`,
    [sessionId],
  );
  if (rows.length === 0) return null;
  if (rows.length > 1) {
    console.warn(`[sessions] Multiple guest gardens for session ${sessionId}; returning first`);
  }
  return {
    gardenName: rows[0].name,
    bedCount: rows[0].bed_count,
    plantCount: rows[0].plant_count,
  };
}

// Look up a session from a signed cookie value - returns null if invalid/expired
export async function findSession(signedToken: string): Promise<SessionData | null> {
  const token = verifyToken(signedToken);
  if (!token) return null;

  const { rows } = await db.query<{
    id: string;
    token: string;
    expires_at: Date;
    account_id: number | null;
    email: string | null;
    role: string | null;
    subscription_tier: string | null;
    deletion_scheduled_at: string | null;
    authenticated_at: Date | null;
  }>(
    `SELECT
       gs.id, gs.token_hash AS token, gs.expires_at, gs.account_id,
       a.email, a.role, a.subscription_tier, a.deletion_scheduled_at,
       gs.authenticated_at
     FROM guest_sessions gs
     LEFT JOIN accounts a ON a.id = gs.account_id
     WHERE gs.token_hash = $1
       AND gs.expires_at > now()`,
    [hashToken(token)],
  );

  if (rows.length === 0) return null;

  const row = rows[0];
  const account: SessionAccount | null = row.account_id
    ? {
        id: row.account_id,
        email: row.email!,
        role: (row.role as 'user' | 'admin'),
        subscriptionTier: effectiveTier(row.subscription_tier as 'free' | 'supporter'),
        deletionScheduledAt: row.deletion_scheduled_at,
      }
    : null;

  return {
    id: row.id,
    token: row.token,
    isGuest: account === null,
    expiresAt: row.expires_at,
    account,
    authenticatedAt: row.authenticated_at,
  };
}

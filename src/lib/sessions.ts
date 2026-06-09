import crypto from 'crypto';
import { db } from './db';
import type { PoolClient } from 'pg';
import type { SessionData, SessionAccount } from '../types';

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

function verifyToken(signed: string): string | null {
  const parts = signed.split('.');
  if (parts.length !== 2) return null;
  const [token, sig] = parts;
  const expected = crypto.createHmac('sha256', process.env.SESSION_SECRET!).update(token).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  return token;
}

// Exported wrapper — lets auth.ts check expired-but-HMAC-valid cookies without a DB lookup
export function verifySignedToken(signed: string): string | null {
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
    secure: process.env.NODE_ENV === 'production',
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
    `INSERT INTO guest_sessions (token, expires_at)
     VALUES ($1, $2)`,
    [token, expiresAt],
  );

  return { signedToken, expiresAt };
}

// Migrate an existing guest session to an authenticated account,
// or create a new authenticated session if no prior session exists.
// Returns the signed token to set in the cookie.
export async function claimSession(
  accountId: number,
  existingToken: string | null,
  client?: PoolClient,
): Promise<{ signedToken: string; expiresAt: Date }> {
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  const runner = client ?? db;

  if (existingToken) {
    await runner.query(
      `UPDATE guest_sessions
       SET account_id = $1, migrated_at = now(), expires_at = $2
       WHERE token = $3`,
      [accountId, expiresAt, existingToken],
    );
    const signedToken = signToken(existingToken);
    return { signedToken, expiresAt };
  }

  const token = generateToken();
  const signedToken = signToken(token);
  await runner.query(
    `INSERT INTO guest_sessions (token, expires_at, account_id, migrated_at)
     VALUES ($1, $2, $3, now())`,
    [token, expiresAt, accountId],
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
  }>(
    `SELECT
       gs.id, gs.token, gs.expires_at, gs.account_id,
       a.email, a.role, a.subscription_tier, a.deletion_scheduled_at
     FROM guest_sessions gs
     LEFT JOIN accounts a ON a.id = gs.account_id
     WHERE gs.token = $1
       AND gs.expires_at > now()
       AND gs.migrated_at IS NOT DISTINCT FROM gs.migrated_at`, // always true; future: add revocation
    [token],
  );

  if (rows.length === 0) return null;

  const row = rows[0];
  const account: SessionAccount | null = row.account_id
    ? {
        id: row.account_id,
        email: row.email!,
        role: (row.role as 'user' | 'admin'),
        subscriptionTier: (row.subscription_tier as 'free' | 'supporter'),
        deletionScheduledAt: row.deletion_scheduled_at,
      }
    : null;

  return {
    id: row.id,
    token: row.token,
    isGuest: account === null,
    expiresAt: row.expires_at,
    account,
  };
}

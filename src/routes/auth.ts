import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import {
  createGuestSession,
  makeSessionCookie,
  clearSessionCookie,
  claimSession,
  revokeAccountSessions,
  verifySignedToken,
  migrateGuestData,
  getPendingGuestData,
  COOKIE_NAME,
} from '../lib/sessions';
import { db } from '../lib/db';
import { logger } from '../lib/logger';
import { hashToken } from '../lib/tokens';
import { issuePasswordResetToken, sendPasswordResetEmail, sendPasswordChangedNotice } from '../lib/accountSecurity';
import { sendVerificationEmail, consumeVerificationToken } from '../lib/emailVerification';
import { passport } from '../lib/oauth/index';
import type { OAuthUser } from '../lib/oauth/providers/google';
import { requireAuth } from '../middleware/auth';
import {
  loginLimiters,
  registerLimiter,
  forgotPasswordLimiter,
  verifyEmailLimiter,
  passwordResetLimiter,
  guestCreateLimiter,
  consumeResetEmailQuota,
  byIp,
} from '../middleware/rateLimiters';
import { LOCATION_NOT_SET } from '../lib/constants';
import { isValidEmail } from '../lib/validation';
import { OAUTH_NONCE_COOKIE, OAUTH_NONCE_COOKIE_OPTIONS, buildOAuthState, verifyOAuthState } from '../lib/oauth/state';
import { resolveOAuthAccount, OAuthUnverifiedEmailError, OAuthLinkRequiresPasswordError } from '../lib/oauth/resolveAccount';
import { queueDeletedGardens, queueSessionGardens, drainSoon } from '../lib/r2Cleanup';

export const authRouter = Router();

// Deletes this guest's gardens that have no plantings, queueing their R2
// folders. The emptiness check is re-run in the DELETE, so a garden that gets
// a planting in between survives and keeps its files.
async function discardEmptyGuestGardens(sessionId: string): Promise<void> {
  const client = await db.connect();
  let queuedIds: number[] = [];
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: number }>(
      'SELECT id FROM gardens WHERE guest_session_id = $1',
      [sessionId],
    );
    ({ ids: queuedIds } = await queueDeletedGardens(
      client,
      rows.map((r) => r.id),
      `DELETE FROM gardens
        WHERE id = ANY($1::int[]) AND guest_session_id = $2
          AND NOT EXISTS (SELECT 1 FROM plantings p JOIN beds b ON b.id = p.bed_id
                          WHERE b.garden_id = gardens.id)
        RETURNING id`,
      [sessionId],
    ));
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  drainSoon(queuedIds);
}

// POST /api/auth/guest
// Creates a guest session for first-time visitors with no cookie.
// Idempotent from the client's perspective — if called with an existing valid session,
// we still honour the existing session (the middleware already populated req.session).
authRouter.post('/guest', guestCreateLimiter, async (req: Request, res: Response): Promise<void> => {
  // If a valid session already exists, return its state rather than creating a duplicate
  if (req.session) {
    res.json({
      data: {
        isGuest: req.session.isGuest,
        sessionId: req.session.id,
      },
    });
    return;
  }

  const { signedToken, expiresAt } = await createGuestSession();
  const cookieExpires = new Date(expiresAt.getTime() + 60 * 24 * 60 * 60 * 1000);
  makeSessionCookie(signedToken, expiresAt, res, cookieExpires);

  res.status(201).json({ data: { isGuest: true } });
});

// GET /api/auth/session
// Returns the current session state. Used by the frontend on app load to determine
// whether the user is a guest, authenticated, or unauthenticated.
authRouter.get('/session', async (req: Request, res: Response): Promise<void> => {
  if (!req.session) {
    // Cold path: check for expired cookie whose HMAC is still valid
    const rawCookie = req.cookies[COOKIE_NAME] as string | undefined;
    if (rawCookie) {
      const token = verifySignedToken(rawCookie);
      if (token) {
        const { rows } = await db.query<{ migrated_at: Date | null }>(
          'SELECT migrated_at FROM guest_sessions WHERE token_hash = $1',
          [hashToken(token)],
        );
        if (rows.length > 0 && rows[0].migrated_at === null) {
          res.json({ data: { authenticated: false, isGuest: false, guestExpired: 'recoverable' } });
          return;
        }
        if (rows.length === 0) {
          res.json({ data: { authenticated: false, isGuest: false, guestExpired: 'gone' } });
          return;
        }
      }
    }
    res.json({ data: { authenticated: false, isGuest: false } });
    return;
  }

  if (req.session.isGuest) {
    const expiresAt = req.session.expiresAt;
    const daysRemaining = Math.ceil((expiresAt.getTime() - Date.now()) / 86_400_000);
    res.json({ data: { authenticated: false, isGuest: true, expiresAt, daysRemaining } });
    return;
  }

  const { account } = req.session;
  const pendingGuestData = await getPendingGuestData(req.session.id);
  res.json({
    data: {
      authenticated: true,
      isGuest: false,
      account: {
        id: account!.id,
        email: account!.email,
        role: account!.role,
        subscriptionTier: account!.subscriptionTier,
        deletionScheduledAt: account!.deletionScheduledAt,
      },
      pendingGuestData,
    },
  });
});

// DELETE /api/auth/session
// Clears the session cookie. For an account session the row is deleted too, so
// a copied cookie stops working. Guest rows are kept: expired guest sessions
// stay recoverable and are cleaned up by the nightly job. The row's unmerged
// guest gardens would cascade away with it, so they are deleted and queued first.
authRouter.delete('/session', async (req: Request, res: Response): Promise<void> => {
  if (req.session && !req.session.isGuest) {
    const client = await db.connect();
    let queuedIds: number[] = [];
    try {
      await client.query('BEGIN');
      queuedIds = await queueSessionGardens(client, [req.session.id]);
      await client.query('DELETE FROM guest_sessions WHERE token_hash = $1', [req.session.token]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    drainSoon(queuedIds);
  }
  clearSessionCookie(res);
  res.json({ data: { success: true } });
});

const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS ?? '12', 10);
const SUPPORTED_PROVIDERS = new Set(['google']);

// POST /api/auth/register
authRouter.post('/register', registerLimiter, async (req: Request, res: Response): Promise<void> => {
  const { email, password } = req.body as { email?: unknown; password?: unknown };

  if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
    res.status(400).json({ error: 'Email and password are required' });
    return;
  }

  if (!isValidEmail(email)) {
    res.status(400).json({ error: 'Invalid email address' });
    return;
  }

  if (password.length < 8) {
    res.status(400).json({ error: 'Password must be at least 8 characters' });
    return;
  }

  // Check for duplicate email
  const existing = await db.query('SELECT id FROM accounts WHERE email = $1', [email.toLowerCase()]);
  if (existing.rows.length > 0) {
    res.status(409).json({ error: 'An account with this email already exists' });
    return;
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  // Prefer a live session; fall back to an expired-but-unmigrated session from the cookie
  let existingToken = req.session?.token ?? null;
  let guestSessionId = req.session?.id ?? null;

  if (!existingToken) {
    const rawCookie = req.cookies[COOKIE_NAME] as string | undefined;
    if (rawCookie) {
      const rawToken = verifySignedToken(rawCookie);
      if (rawToken) {
        const tokenHash = hashToken(rawToken);
        const { rows: expiredRows } = await db.query<{ id: string }>(
          'SELECT id FROM guest_sessions WHERE token_hash = $1 AND migrated_at IS NULL',
          [tokenHash],
        );
        if (expiredRows.length > 0) {
          existingToken = tokenHash;
          guestSessionId = expiredRows[0].id;
        }
      }
    }
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO accounts (email, password_hash, zone, zone_location_label)
       VALUES ($1, $2, 'unknown', $3)
       RETURNING id`,
      [email.toLowerCase(), passwordHash, LOCATION_NOT_SET],
    );
    const accountId = rows[0].id;

    const { signedToken, expiresAt } = await claimSession(accountId, existingToken, client);

    if (guestSessionId) {
      await migrateGuestData(client, guestSessionId, accountId);
    }

    await client.query('COMMIT');

    // Soft verification: nothing is gated, so a mail failure must not fail signup.
    sendVerificationEmail(accountId, email.toLowerCase()).catch((err: unknown) =>
      logger.error('Failed to send verification email', err, { accountId }),
    );

    makeSessionCookie(signedToken, expiresAt, res);
    res.status(201).json({
      data: {
        authenticated: true,
        account: { id: accountId, email: email.toLowerCase() },
      },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// POST /api/auth/login
authRouter.post('/login', ...loginLimiters.handlers, async (req: Request, res: Response): Promise<void> => {
  const { email, password } = req.body as { email?: unknown; password?: unknown };

  if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
    res.status(400).json({ error: 'Email and password are required' });
    return;
  }

  const { rows } = await db.query<{
    id: number;
    email: string;
    password_hash: string | null;
    role: string;
    subscription_tier: string;
  }>(
    `SELECT id, email, password_hash, role, subscription_tier
     FROM accounts WHERE email = $1`,
    [email.toLowerCase()],
  );

  const dummyHash = '$2b$12$invalidhashfordummycomparisononly.........';
  const hash = rows[0]?.password_hash ?? dummyHash;
  const valid = await bcrypt.compare(password, hash);

  if (!valid || rows.length === 0) {
    // No email address in the log: the account id (when there is one) and IP
    // are enough to spot credential stuffing.
    logger.warn('Login failed', {
      reason: rows.length === 0 ? 'unknown_account' : 'bad_password',
      accountId: rows[0]?.id ?? null,
      ip: req.ip,
    });
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }

  const account = rows[0];

  await db.query(
    `UPDATE accounts SET last_active_at = now() WHERE id = $1
     AND (last_active_at IS NULL OR last_active_at < now() - interval '1 hour')`,
    [account.id],
  );

  const sessionId = req.session?.id ?? null;
  const existingToken = req.session?.token ?? null;

  // Re-check the credential under a lock: an OAuth claim of this (unverified)
  // account may have committed while bcrypt was running.
  let signedToken: string;
  let expiresAt: Date;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query<{ password_hash: string | null }>(
      'SELECT password_hash FROM accounts WHERE id = $1 FOR SHARE',
      [account.id],
    );
    if (current.rows[0]?.password_hash !== account.password_hash) {
      await client.query('ROLLBACK');
      logger.warn('Login failed', { reason: 'changed_during_login', accountId: account.id, ip: req.ip });
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }
    ({ signedToken, expiresAt } = await claimSession(account.id, existingToken, client));
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  makeSessionCookie(signedToken, expiresAt, res);

  // Silent-discard: delete any guest gardens with zero plantings (cascade removes beds).
  // Gardens with plantings survive for the merge prompt.
  if (sessionId) await discardEmptyGuestGardens(sessionId);

  res.json({
    data: {
      authenticated: true,
      account: {
        id: account.id,
        email: account.email,
        role: account.role,
        subscriptionTier: account.subscription_tier,
      },
    },
  });
});

// POST /api/auth/forgot-password
authRouter.post('/forgot-password', forgotPasswordLimiter, async (req: Request, res: Response): Promise<void> => {
  const { email } = req.body as { email?: unknown };

  if (typeof email !== 'string' || !email) {
    res.status(400).json({ error: 'Email is required' });
    return;
  }

  // Always return 200 regardless of whether the email exists — prevents enumeration
  res.json({ data: { message: 'If an account with that email exists, a reset link has been sent.' } });

  // Do the work after responding; failures can only be logged, not returned.
  const normalized = email.trim().toLowerCase();
  if (!isValidEmail(normalized)) return;
  try {
    const { rows } = await db.query<{ id: number }>(
      'SELECT id FROM accounts WHERE email = $1',
      [normalized],
    );
    if (rows.length === 0) return;

    const accountId = rows[0].id;
    let rawToken = '';

    // One live token per account: a new request invalidates earlier links.
    const client = await db.connect();
    let duplicate = false;
    try {
      await client.query('BEGIN');
      // Serialise concurrent requests for the same account so only one live token remains.
      await client.query('SELECT 1 FROM accounts WHERE id = $1 FOR UPDATE', [accountId]);
      // A token issued in the last ~5 minutes (more than 55 of its 60 minutes
      // left) means this is a repeat click — keep that link, send nothing.
      // Trade-off: within 5 minutes a re-request does not rotate the link.
      const { rows: fresh } = await client.query(
        `SELECT 1 FROM password_reset_tokens
          WHERE account_id = $1 AND used_at IS NULL AND expires_at > NOW() + INTERVAL '55 minutes'
          LIMIT 1`,
        [accountId],
      );
      // Quota is spent only when an email is actually about to be sent.
      if (fresh.length > 0 || !consumeResetEmailQuota(normalized, byIp(req))) {
        duplicate = true;
      } else {
        rawToken = await issuePasswordResetToken(client, accountId);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    if (duplicate) return;

    await sendPasswordResetEmail(normalized, rawToken);
  } catch (err) {
    logger.error('forgot-password background work failed', err);
  }
});

// POST /api/auth/reset-password
authRouter.post('/reset-password', passwordResetLimiter, async (req: Request, res: Response): Promise<void> => {
  const { token, password } = req.body as { token?: unknown; password?: unknown };

  if (typeof token !== 'string' || typeof password !== 'string' || !token || !password) {
    res.status(400).json({ error: 'Token and new password are required' });
    return;
  }

  if (password.length < 8) {
    res.status(400).json({ error: 'Password must be at least 8 characters' });
    return;
  }

  const invalid = { error: 'Invalid or expired reset token' };
  const { rows } = await db.query<{ id: number; account_id: number }>(
    `SELECT id, account_id FROM password_reset_tokens
     WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
    [hashToken(token)],
  );
  if (rows.length === 0) {
    res.status(400).json(invalid);
    return;
  }
  const { id: tokenId, account_id: accountId } = rows[0];

  const newHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  let email: string | null = null;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Claim the token inside the transaction so two concurrent requests can't both use it.
    const claimed = await client.query(
      'UPDATE password_reset_tokens SET used_at = now() WHERE id = $1 AND used_at IS NULL AND expires_at > now()',
      [tokenId],
    );
    if (claimed.rowCount === 0) {
      await client.query('ROLLBACK');
      res.status(400).json(invalid);
      return;
    }
    // Completing a reset proves control of the inbox, so the email is verified.
    const { rows: updated } = await client.query<{ email: string | null }>(
      'UPDATE accounts SET password_hash = $1, email_verified = true, pending_email = NULL, updated_at = now() WHERE id = $2 RETURNING email',
      [newHash, accountId],
    );
    email = updated[0]?.email ?? null;
    // A pending email change must not survive a reset (its link may be in an attacker's inbox).
    await client.query('DELETE FROM email_change_tokens WHERE account_id = $1', [accountId]);
    await client.query(
      'DELETE FROM password_reset_tokens WHERE account_id = $1 AND used_at IS NULL',
      [accountId],
    );
    await revokeAccountSessions(client, accountId);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  // Proving the inbox lifts that address's login lockout (this IP's pair and
  // the address-wide bucket), so the owner can sign in with the new password.
  if (email) loginLimiters.reset(email, req);

  res.json({ data: { success: true, message: 'Password updated. You can now log in.' } });
  if (email) await sendPasswordChangedNotice(email);
});

// POST /api/auth/email/revert
// Public: the link was mailed to the replaced address, and whoever made the
// change may hold every session and the password. Puts the old address back,
// scrambles the password, signs out every device, and mails a reset link.
authRouter.post('/email/revert', passwordResetLimiter, async (req: Request, res: Response): Promise<void> => {
  const { token } = req.body as { token?: unknown };
  const invalid = { error: 'This link is invalid or has expired.' };
  const taken = { error: 'That address is now used by another account. Please contact support.' };
  if (typeof token !== 'string' || !token) {
    res.status(400).json(invalid);
    return;
  }

  // Hashed before the transaction: bcrypt is slow and shouldn't hold row locks.
  const scrambledHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), BCRYPT_ROUNDS);

  let restored: { email: string; resetToken: string } | null = null;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: number; account_id: number; old_email: string }>(
      `UPDATE email_revert_tokens SET used_at = NOW()
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()
        RETURNING id, account_id, old_email`,
      [hashToken(token)],
    );
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      res.status(400).json(invalid);
      return;
    }
    const { id: tokenId, account_id: accountId, old_email: oldEmail } = rows[0];

    await client.query('SELECT 1 FROM accounts WHERE id = $1 FOR UPDATE', [accountId]);
    const { rows: owner } = await client.query('SELECT 1 FROM accounts WHERE email = $1 AND id <> $2', [
      oldEmail,
      accountId,
    ]);
    if (owner.length > 0) {
      await client.query('ROLLBACK');
      res.status(409).json(taken);
      return;
    }

    await client.query(
      `UPDATE accounts
          SET email = $1, email_verified = true, pending_email = NULL, password_hash = $2, updated_at = NOW()
        WHERE id = $3`,
      [oldEmail, scrambledHash, accountId],
    );
    // Only newer links are cancelled: after a chain of changes (A→B→C) the
    // link mailed to A stays valid, so the one closest to the owner wins.
    await client.query(
      'UPDATE email_revert_tokens SET used_at = NOW() WHERE account_id = $1 AND used_at IS NULL AND id > $2',
      [accountId, tokenId],
    );
    await client.query('UPDATE email_change_tokens SET used_at = NOW() WHERE account_id = $1 AND used_at IS NULL', [
      accountId,
    ]);
    // Google auto-links by email, so whoever changed the address could have
    // linked their own Google account. The owner re-links by signing in with
    // Google as the restored address.
    await client.query('DELETE FROM oauth_identities WHERE account_id = $1', [accountId]);
    await revokeAccountSessions(client, accountId);
    const resetToken = await issuePasswordResetToken(client, accountId);
    await client.query('COMMIT');
    restored = { email: oldEmail, resetToken };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // Another account claimed the address between the check and the update.
    if ((err as { code?: string }).code === '23505') {
      res.status(409).json(taken);
      return;
    }
    logger.error('POST /auth/email/revert failed', err);
    res.status(500).json({ error: 'Internal server error' });
    return;
  } finally {
    client.release();
  }

  res.json({ data: { email: restored.email } });
  try {
    await sendPasswordResetEmail(restored.email, restored.resetToken);
  } catch (err) {
    logger.error('Email revert: reset email failed to send', err);
  }
});

// POST /api/auth/verify-email
// Public: the token itself is the proof, so the link works logged out or on another device.
authRouter.post('/verify-email', verifyEmailLimiter, async (req: Request, res: Response): Promise<void> => {
  const { token } = req.body as { token?: unknown };
  if (typeof token !== 'string' || !token) {
    res.status(400).json({ error: 'Token is required.' });
    return;
  }
  const verified = await consumeVerificationToken(token);
  if (!verified) {
    res.status(400).json({ error: 'This verification link is invalid or has expired.' });
    return;
  }
  res.json({ data: { verified: true } });
});

// GET /api/auth/oauth/:provider — initiate OAuth flow
authRouter.get('/oauth/:provider', (req: Request, res: Response, next) => {
  const provider = req.params.provider as string;
  if (!SUPPORTED_PROVIDERS.has(provider)) {
    return res.status(400).json({ error: 'Unknown OAuth provider' });
  }

  const nonce = crypto.randomBytes(16).toString('hex');
  const state = buildOAuthState(nonce, req.query.returnTo);

  res.cookie(OAUTH_NONCE_COOKIE, nonce, {
    ...OAUTH_NONCE_COOKIE_OPTIONS,
    maxAge: 10 * 60 * 1000,
  });

  passport.authenticate('google', {
    scope: ['openid', 'email', 'profile'],
    state,
    session: false,
  })(req, res, next);
});

// GET /api/auth/oauth/google/callback — handles return from Google
authRouter.get(
  '/oauth/google/callback',
  verifyOAuthState,
  passport.authenticate('google', {
    session: false,
    failureRedirect: `${process.env.FRONTEND_URL}/login?error=oauth_failed`,
  }),
  async (req: Request, res: Response) => {
    try {
      const returnTo = res.locals.returnTo as string;

      const oauthUser = req.user as OAuthUser;
      const guestSessionId = req.session?.id ?? null;
      const { accountId, isNew } = await resolveOAuthAccount(oauthUser, guestSessionId);

      const existingToken = req.session?.token ?? null;
      const { signedToken, expiresAt } = await claimSession(accountId, existingToken);
      makeSessionCookie(signedToken, expiresAt, res);

      // Existing accounts: silent-discard guest gardens with zero plantings
      if (!isNew && guestSessionId) {
        await discardEmptyGuestGardens(guestSessionId);
      }

      res.redirect(`${process.env.FRONTEND_URL}${returnTo}`);
    } catch (err) {
      if (err instanceof OAuthUnverifiedEmailError) {
        return res.redirect(`${process.env.FRONTEND_URL}/login?error=oauth_unverified`);
      }
      if (err instanceof OAuthLinkRequiresPasswordError) {
        return res.redirect(`${process.env.FRONTEND_URL}/login?error=oauth_link_password`);
      }
      logger.error('GET /auth/oauth/google/callback failed', err);
      res.redirect(`${process.env.FRONTEND_URL}/login?error=oauth_error`);
    }
  },
);

// POST /api/auth/guest-data/merge
// Migrate pending guest gardens/seeds to the authenticated account. No-op-safe.
authRouter.post(
  '/guest-data/merge',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.session!.id;
    const accountId = req.session!.account!.id;
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await migrateGuestData(client, sessionId, accountId);
      await client.query('COMMIT');
      res.json({ data: { merged: true } });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },
);

// POST /api/auth/guest-data/discard
// Delete pending guest gardens and seeds. No-op-safe.
authRouter.post(
  '/guest-data/discard',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.session!.id;
    const client = await db.connect();
    let queuedIds: number[] = [];
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ id: number }>(
        'SELECT id FROM gardens WHERE guest_session_id = $1',
        [sessionId],
      );
      ({ ids: queuedIds } = await queueDeletedGardens(
        client,
        rows.map((r) => r.id),
        'DELETE FROM gardens WHERE id = ANY($1::int[]) AND guest_session_id = $2 RETURNING id',
        [sessionId],
      ));
      await client.query('DELETE FROM seeds    WHERE guest_session_id = $1', [sessionId]);
      await client.query('COMMIT');
      drainSoon(queuedIds);
      res.json({ data: { discarded: true } });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },
);

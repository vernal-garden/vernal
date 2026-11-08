import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcrypt';
import { effectiveTier } from '../lib/tier';
import { getBetaSettings, betaAccessApplies, decideSignup } from '../lib/beta';
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
import { TERMS_VERSION, BETA_TERMS_VERSION } from '../lib/legal';
import { hashToken } from '../lib/tokens';
import { issuePasswordResetToken, sendPasswordResetEmail, sendPasswordChangedNotice } from '../lib/accountSecurity';
import {
  sendVerificationEmail,
  consumeVerificationToken,
  inspectVerificationToken,
  type VerificationTokenInfo,
} from '../lib/emailVerification';
import { passport } from '../lib/oauth/index';
import type { OAuthUser } from '../lib/oauth/providers/google';
import { requireAuth } from '../middleware/auth';
import { requireMail } from '../middleware/requireMail';
import { isMailEnabled, secureCookies } from '../lib/serverConfig';
import {
  loginLimiters,
  registerLimiter,
  forgotPasswordLimiter,
  verifyEmailLimiter,
  verifyEmailInspectLimiter,
  notMeLimiter,
  takeoverLimiter,
  passwordResetLimiter,
  passwordResetInspectLimiter,
  guestCreateLimiter,
  consumeResetEmailQuota,
  byIp,
} from '../middleware/rateLimiters';
import { LOCATION_NOT_SET } from '../lib/constants';
import { isValidEmail } from '../lib/validation';
import { OAUTH_NONCE_COOKIE, OAUTH_NONCE_COOKIE_OPTIONS, buildOAuthState, verifyOAuthState } from '../lib/oauth/state';
import {
  resolveOAuthAccount,
  OAuthUnverifiedEmailError,
  OAuthLinkRequiresPasswordError,
  OAuthNotInvitedError,
  OAuthTakeoverChoiceRequired,
  OAuthTakeoverInvalidError,
  OAuthTakeoverChangedError,
  inspectOAuthTakeover,
  completeOAuthTakeover,
  TAKEOVER_MINUTES,
  type TakeoverChoice,
} from '../lib/oauth/resolveAccount';
import { requireGoogleSignIn } from '../middleware/requireGoogleSignIn';
import { queueDeletedGardens, queueSessionGardens, drainSoon } from '../lib/r2Cleanup';
import {
  billingSettledNotDisplaced,
  displaceAccount,
  finishDisplacement,
  settleDisplacedBilling,
  type SettledBilling,
} from '../lib/displacement';

export const authRouter = Router();

const NOT_INVITED = { error: "That email address isn't on the invite list.", code: 'not_invited' };

// Proving the inbox of an UNVERIFIED account (reset link, verification link,
// Google) asks whether the person created it before anything changes.
const TAKEOVER_CHOICE_REQUIRED = {
  error: 'Tell us whether you created this account.',
  code: 'takeover_choice_required',
};
const INVALID_CHOICE = { ...TAKEOVER_CHOICE_REQUIRED };

// undefined/null → null (not given); anything but the two answers → 'invalid'.
function parseTakeoverChoice(value: unknown): TakeoverChoice | null | 'invalid' {
  if (value === undefined || value === null) return null;
  return value === 'mine' || value === 'not_mine' ? value : 'invalid';
}

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

  if (!(await getBetaSettings()).guestModeOn) {
    res.status(403).json({ error: 'Vernal is in private beta.', code: 'guest_mode_off' });
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
        betaParticipant: account!.betaParticipant,
        betaTermsRequired: account!.betaTermsPending,
        termsRequired: account!.termsPending,
        // The version POST /api/me/terms expects, so a stale screen can't accept newer Terms.
        termsVersion: TERMS_VERSION,
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
// Same default as the CORS origin in index.ts; serverConfig requires FRONTEND_URL in production.
const frontendUrl = () => process.env.FRONTEND_URL ?? 'http://localhost:5173';

// POST /api/auth/register
authRouter.post('/register', registerLimiter, async (req: Request, res: Response): Promise<void> => {
  const { email, password, acceptBetaTerms } = req.body as {
    email?: unknown;
    password?: unknown;
    acceptBetaTerms?: unknown;
  };

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

    // Invite gate. A refusal creates nothing: no account, no claimed session, no migrated data.
    const decision = await decideSignup(client, email.toLowerCase(), guestSessionId);
    if (!decision.allowed) {
      await client.query('ROLLBACK');
      res.status(403).json(NOT_INVITED);
      return;
    }
    const participant = decision.participant;
    // A second fresh read; it can differ from decideSignup's only if the gate flips mid-request.
    // Both outcomes are safe: seeing off creates a pending participant the terms gate holds,
    // seeing on gives the invited user a 400 to retry.
    const gateOn =
      participant &&
      (await client.query<{ gate_on: boolean }>('SELECT gate_on FROM beta_settings WHERE id = 1')).rows[0].gate_on;
    if (gateOn && acceptBetaTerms !== true) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: 'Accept the beta terms to continue.', code: 'beta_terms_required' });
      return;
    }
    const acceptedBeta = participant && acceptBetaTerms === true;

    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO accounts (email, password_hash, zone, zone_location_label, terms_version, terms_accepted_at,
                             beta_participant_at, beta_terms_version, beta_terms_accepted_at)
       VALUES ($1, $2, 'unknown', $3, $4, NOW(),
               CASE WHEN $5::boolean THEN NOW() END,
               CASE WHEN $6::boolean THEN $7::text END,
               CASE WHEN $6::boolean THEN NOW() END)
       RETURNING id`,
      [email.toLowerCase(), passwordHash, LOCATION_NOT_SET, TERMS_VERSION, participant, acceptedBeta, BETA_TERMS_VERSION],
    );
    const accountId = rows[0].id;

    const { signedToken, expiresAt } = await claimSession(accountId, existingToken, client);

    if (guestSessionId) {
      await migrateGuestData(client, guestSessionId, accountId);
    }

    await client.query('COMMIT');

    // Soft verification: nothing is gated, so a mail failure must not fail signup.
    // With mail off there is nothing to send, so no token is created either.
    if (isMailEnabled()) {
      sendVerificationEmail(accountId, email.toLowerCase()).catch((err: unknown) =>
        logger.error('Failed to send verification email', err, { accountId }),
      );
    }

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
    beta_participant_at: Date | null;
  }>(
    `SELECT id, email, password_hash, role, subscription_tier, beta_participant_at
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
  // Read before the transaction: a failed read must not turn a committed login into a 500.
  const beta = await getBetaSettings();

  await db.query(
    `UPDATE accounts SET last_active_at = now() WHERE id = $1
     AND (last_active_at IS NULL OR last_active_at < now() - interval '1 hour')`,
    [account.id],
  );

  const sessionId = req.session?.id ?? null;
  const existingToken = req.session?.token ?? null;

  // Re-check the credential under a lock: an OAuth claim of this account may
  // have committed while bcrypt was running.
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
        subscriptionTier: effectiveTier(
          account.subscription_tier as 'free' | 'supporter',
          betaAccessApplies(account.beta_participant_at, beta),
        ),
      },
    },
  });
});

// POST /api/auth/forgot-password
authRouter.post('/forgot-password', requireMail, forgotPasswordLimiter, async (req: Request, res: Response): Promise<void> => {
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

// The reset token's account, if the token is usable. Never consumes it.
async function findResetToken(
  token: string,
): Promise<{ id: number; accountId: number; email: string; emailVerified: boolean; minutesLeft: number } | null> {
  const { rows } = await db.query<{
    id: number;
    account_id: number;
    email: string;
    email_verified: boolean;
    minutes_left: number;
  }>(
    `SELECT t.id, t.account_id, a.email, a.email_verified,
            EXTRACT(EPOCH FROM (t.expires_at - now())) / 60 AS minutes_left
       FROM password_reset_tokens t
       JOIN accounts a ON a.id = t.account_id
      WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.expires_at > now()`,
    [hashToken(token)],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    accountId: row.account_id,
    email: row.email,
    emailVerified: row.email_verified,
    minutesLeft: Number(row.minutes_left),
  };
}

const INVALID_RESET = { error: 'Invalid or expired reset token' };
// Stripe is settled before the reset; a link this close to expiry could run
// out in between, leaving billing settled and the account kept.
const MIN_RESET_MINUTES_FOR_DISPLACEMENT = 10;

// POST /api/auth/reset-password/inspect
// Whether the link's account is unverified (so the page must ask whether the
// person created it), and its address, shown with the question (the token
// holder has proven the inbox). Never consumes the token.
authRouter.post('/reset-password/inspect', passwordResetInspectLimiter, async (req: Request, res: Response): Promise<void> => {
  const { token } = req.body as { token?: unknown };
  if (typeof token !== 'string' || !token) {
    res.status(400).json(INVALID_RESET);
    return;
  }
  const found = await findResetToken(token);
  if (!found) {
    res.status(400).json(INVALID_RESET);
    return;
  }
  res.json({ data: { unverifiedAccount: !found.emailVerified, email: found.email } });
});

// POST /api/auth/reset-password
// Completing a reset proves control of the inbox. On an UNVERIFIED account
// the person must say whether they created it (choice):
// - 'mine' → the account is kept: new password, verified, and claimed
//   (Terms and beta terms cleared, claimed_at set) so the Terms prompt holds it.
// - 'not_mine' → displaced (see displacement.ts) and the owner gets a new
//   account with this password. The sign-up decision and Stripe come first:
//   a refusal or a Stripe failure changes nothing, and the token stays usable.
// A verified account ignores choice.
authRouter.post('/reset-password', passwordResetLimiter, async (req: Request, res: Response): Promise<void> => {
  const { token, password, choice: rawChoice } = req.body as { token?: unknown; password?: unknown; choice?: unknown };

  if (typeof token !== 'string' || typeof password !== 'string' || !token || !password) {
    res.status(400).json({ error: 'Token and new password are required' });
    return;
  }

  if (password.length < 8) {
    res.status(400).json({ error: 'Password must be at least 8 characters' });
    return;
  }

  const choice = parseTakeoverChoice(rawChoice);
  if (choice === 'invalid') {
    res.status(400).json(INVALID_CHOICE);
    return;
  }

  const found = await findResetToken(token);
  if (!found) {
    res.status(400).json(INVALID_RESET);
    return;
  }
  const { id: tokenId, accountId } = found;
  // The address and state the answer is about; rechecked under the lock.
  const unverifiedEmail = found.emailVerified ? null : found.email;
  if (unverifiedEmail && choice === null) {
    res.status(409).json(TAKEOVER_CHOICE_REQUIRED);
    return;
  }
  const displace = unverifiedEmail !== null && choice === 'not_mine';

  let settled: SettledBilling | null = null;
  if (displace) {
    if (found.minutesLeft < MIN_RESET_MINUTES_FOR_DISPLACEMENT) {
      res.status(400).json({ error: 'This reset link has nearly expired. Please request a new one.' });
      return;
    }
    const precheck = await db.connect();
    let allowed: boolean;
    try {
      allowed = (await decideSignup(precheck, unverifiedEmail, null)).allowed;
    } finally {
      precheck.release();
    }
    if (!allowed) {
      res.status(403).json(NOT_INVITED);
      return;
    }
    try {
      settled = await settleDisplacedBilling(db, accountId);
    } catch (err) {
      logger.error('Could not settle billing for a displaced account; reset refused', err, { accountId });
      res.status(502).json({ error: "We couldn't finish resetting your password, so nothing was changed. Please try again." });
      return;
    }
  }

  let email: string | null = null;
  let displaced = false;
  try {
    const newHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
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
        res.status(400).json(INVALID_RESET);
        return;
      }
      const { rows: locked } = await client.query<{ email: string; email_verified: boolean }>(
        'SELECT email, email_verified FROM accounts WHERE id = $1 FOR UPDATE',
        [accountId],
      );
      const current = locked[0];
      // The answer was about this account as it was: unverified, holding that address.
      const changed =
        !current ||
        (unverifiedEmail !== null && (current.email !== unverifiedEmail || current.email_verified)) ||
        (unverifiedEmail === null && !current.email_verified);
      if (changed) {
        await client.query('ROLLBACK');
        res.status(409).json({ error: 'Your account changed during the reset. Please try again.' });
        return;
      }
      if (displace) {
        const decision = await decideSignup(client, current.email, null);
        if (!decision.allowed) {
          await client.query('ROLLBACK');
          res.status(403).json(NOT_INVITED);
          return;
        }
        await displaceAccount(client, accountId);
        // The owner never accepted the Terms for this account: claimed_at with no
        // acceptance holds them at the Terms screen until they do.
        await client.query(
          `INSERT INTO accounts (email, password_hash, email_verified, zone, zone_location_label, claimed_at,
                                 beta_participant_at)
           VALUES ($1, $2, true, 'unknown', $3, now(), CASE WHEN $4::boolean THEN now() END)`,
          [current.email, newHash, LOCATION_NOT_SET, decision.participant],
        );
        displaced = true;
      } else {
        if (unverifiedEmail !== null) {
          // 'mine': kept in place, verified, and held at the Terms prompt.
          await client.query(
            `UPDATE accounts
                SET password_hash = $1, pending_email = NULL, email_verified = true, claimed_at = now(),
                    terms_version = NULL, terms_accepted_at = NULL,
                    beta_terms_version = NULL, beta_terms_accepted_at = NULL, updated_at = now()
              WHERE id = $2`,
            [newHash, accountId],
          );
          await client.query('DELETE FROM email_verification_tokens WHERE account_id = $1', [accountId]);
          await client.query('DELETE FROM pending_takeovers WHERE account_id = $1', [accountId]);
        } else {
          await client.query(
            'UPDATE accounts SET password_hash = $1, pending_email = NULL, updated_at = now() WHERE id = $2',
            [newHash, accountId],
          );
        }
        // A pending email change must not survive a reset (its link may be in an attacker's inbox).
        await client.query('DELETE FROM email_change_tokens WHERE account_id = $1', [accountId]);
        await client.query(
          'DELETE FROM password_reset_tokens WHERE account_id = $1 AND used_at IS NULL',
          [accountId],
        );
        await revokeAccountSessions(client, accountId);
      }
      email = current.email;
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } finally {
    if (settled && !displaced) await billingSettledNotDisplaced(accountId);
  }
  if (settled && displaced) await finishDisplacement(settled, { path: 'password_reset' });
  // Proving the inbox lifts that address's login lockout (this IP's pair and
  // the address-wide bucket), so the owner can sign in with the new password.
  if (email) loginLimiters.reset(email, req);

  // newAccount: what was done, not what was asked. A 'not_mine' on an account
  // verified since the page asked is a plain reset (newAccount false).
  res.json({ data: { success: true, message: 'Password updated. You can now log in.', newAccount: displaced } });
  if (email) await sendPasswordChangedNotice(email);
});

// requireMail for the revert route, with its own answer: the generic one gives
// the owner no way forward (an admin can restore the address with the CLI).
function requireMailForRevert(_req: Request, res: Response, next: NextFunction): void {
  if (!isMailEnabled()) {
    res.status(409).json({
      error:
        "This server can't send email right now, so this change can't be undone here. Please contact the server's administrator — they can restore your previous address.",
    });
    return;
  }
  next();
}

// POST /api/auth/email/revert
// Public: the link was mailed to the replaced address, and whoever made the
// change may hold every session and the password. Puts the old address back,
// scrambles the password, signs out every device, and mails a reset link.
// Refused while mail is off: the reset link could not be sent, so the owner
// would be locked out.
authRouter.post('/email/revert', requireMailForRevert, passwordResetLimiter, async (req: Request, res: Response): Promise<void> => {
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

const INVALID_VERIFICATION = { error: 'This verification link is invalid or has expired.' };
// Stripe is settled before the removal; a link this close to expiry could run
// out in between, leaving billing settled and the account kept.
const MIN_LINK_MINUTES_FOR_DISPLACEMENT = 2;

// Deletes the unverified account a verification link belongs to, for someone
// who says they didn't create it ("This wasn't me", or 'not_mine' on the
// verify page). No new account is made and nobody is signed in. Billing is
// settled first (Stripe, outside the transaction); a Stripe failure changes
// nothing and the link stays usable.
async function removeUnverifiedAccount(
  rawToken: string,
): Promise<'removed' | 'invalid' | 'already_verified' | 'nearly_expired' | 'billing_failed'> {
  const found = await inspectVerificationToken(rawToken);
  if (!found) return 'invalid';
  if (found.emailVerified) return 'already_verified';
  if (found.minutesLeft < MIN_LINK_MINUTES_FOR_DISPLACEMENT) return 'nearly_expired';
  const { accountId } = found;

  let settled: SettledBilling;
  try {
    settled = await settleDisplacedBilling(db, accountId);
  } catch (err) {
    logger.error('Could not settle billing for a displaced account; removal refused', err, { accountId });
    return 'billing_failed';
  }

  let outcome: 'removed' | 'invalid' | 'already_verified' = 'invalid';
  try {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      // Account row first, then the token, the same lock order as the other paths.
      const { rows: account } = await client.query<{ email: string; email_verified: boolean }>(
        'SELECT email, email_verified FROM accounts WHERE id = $1 FOR UPDATE',
        [accountId],
      );
      const { rows } = await client.query<{ id: number }>(
        `SELECT t.id FROM email_verification_tokens t
           JOIN accounts a ON a.id = t.account_id AND a.email = t.email
          WHERE t.token_hash = $1 AND t.account_id = $2 AND t.used_at IS NULL AND t.expires_at > now()
          FOR UPDATE OF t`,
        [hashToken(rawToken), accountId],
      );
      if (rows.length === 0 || !account[0] || account[0].email !== found.email) {
        outcome = 'invalid';
        await client.query('ROLLBACK');
      } else if (account[0].email_verified) {
        outcome = 'already_verified';
        await client.query('ROLLBACK');
      } else {
        await client.query('UPDATE email_verification_tokens SET used_at = now() WHERE id = $1', [rows[0].id]);
        await displaceAccount(client, accountId);
        await client.query('COMMIT');
        outcome = 'removed';
      }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  } finally {
    if (outcome !== 'removed') await billingSettledNotDisplaced(accountId);
  }
  if (outcome === 'removed') await finishDisplacement(settled, { path: 'not_me' });
  return outcome;
}

const ALREADY_VERIFIED = {
  error: "This account has already been verified, so it can't be removed from this link.",
  code: 'already_verified',
};

function sendRemovalOutcome(res: Response, outcome: Awaited<ReturnType<typeof removeUnverifiedAccount>>): void {
  if (outcome === 'removed') {
    res.json({ data: { removed: true } });
  } else if (outcome === 'already_verified') {
    res.status(409).json(ALREADY_VERIFIED);
  } else if (outcome === 'nearly_expired') {
    res.status(400).json({ error: 'This verification link has nearly expired. Please request a new one.' });
  } else if (outcome === 'billing_failed') {
    res.status(502).json({ error: "We couldn't remove the account, so nothing was changed. Please try again." });
  } else {
    res.status(400).json(INVALID_VERIFICATION);
  }
}

// Whether this request's session can verify the link's account without the
// question: signed in as that account, by a sign-in made before the link was
// issued. A session signed in afterwards could be anyone who knows the
// password (or a browser signed in by someone else), so it is asked.
function trustedForVerification(req: Request, found: VerificationTokenInfo): boolean {
  const session = req.session;
  if (!session?.account || session.account.id !== found.accountId) return false;
  return session.authenticatedAt !== null && session.authenticatedAt < found.issuedAt;
}

// POST /api/auth/verify-email/inspect { token }
// Whether the page can verify straight away (see trustedForVerification, or
// the account is already verified) or must first ask whether the person
// created the account, and the address, shown with the question (the token
// holder has proven the inbox). Never consumes the token. A POST so the token
// stays out of URLs and logs.
authRouter.post('/verify-email/inspect', verifyEmailInspectLimiter, async (req: Request, res: Response): Promise<void> => {
  const { token } = req.body as { token?: unknown };
  if (typeof token !== 'string' || !token) {
    res.status(400).json(INVALID_VERIFICATION);
    return;
  }
  const found = await inspectVerificationToken(token);
  if (!found) {
    res.status(400).json(INVALID_VERIFICATION);
    return;
  }
  res.json({
    data: {
      signedInAsAccount: trustedForVerification(req, found),
      unverifiedAccount: !found.emailVerified,
      email: found.email,
    },
  });
});

// POST /api/auth/verify-email
// Public: the token itself is the proof, so the link works logged out or on another device.
// Already verified, or trusted (see trustedForVerification) with no choice
// or 'mine' → verified, no question. Otherwise an unverified account needs choice:
// - 'mine' → verified and claimed (Terms and beta terms cleared, claimed_at
//   set, pending email changes dropped, every session signed out), so whoever
//   answered accepts the Terms in their own name.
// - 'not_mine' → the account is removed, as POST /not-me. An explicit
//   'not_mine' always removes it, even from a trusted session; on a verified
//   account it is refused (409 already_verified) and the link is left unused.
authRouter.post('/verify-email', verifyEmailLimiter, async (req: Request, res: Response): Promise<void> => {
  const { token, choice: rawChoice } = req.body as { token?: unknown; choice?: unknown };
  if (typeof token !== 'string' || !token) {
    res.status(400).json({ error: 'Token is required.' });
    return;
  }
  const choice = parseTakeoverChoice(rawChoice);
  if (choice === 'invalid') {
    res.status(400).json(INVALID_CHOICE);
    return;
  }
  const found = await inspectVerificationToken(token);
  if (!found) {
    res.status(400).json(INVALID_VERIFICATION);
    return;
  }
  if (choice === 'not_mine') {
    // Removal only, never a verification: a verified account answers as /not-me does.
    sendRemovalOutcome(res, found.emailVerified ? 'already_verified' : await removeUnverifiedAccount(token));
    return;
  }
  const trusted = trustedForVerification(req, found);
  if (!found.emailVerified && !trusted && choice === null) {
    // The address, as inspect gives it: shown with the question.
    res.status(409).json({ ...TAKEOVER_CHOICE_REQUIRED, email: found.email });
    return;
  }
  const claim = !found.emailVerified && !trusted;
  const verified = await consumeVerificationToken(token, { claim });
  if (!verified) {
    res.status(400).json(INVALID_VERIFICATION);
    return;
  }
  res.json({ data: { verified: true } });
});

// POST /api/auth/not-me { token }
// The "This wasn't me" link in the verification email. The page only asks;
// only this POST acts (mail scanners follow links). Never signs anyone in.
authRouter.post('/not-me', notMeLimiter, async (req: Request, res: Response): Promise<void> => {
  const { token } = req.body as { token?: unknown };
  if (typeof token !== 'string' || !token) {
    res.status(400).json(INVALID_VERIFICATION);
    return;
  }
  sendRemovalOutcome(res, await removeUnverifiedAccount(token));
});

// GET /api/auth/oauth/:provider — initiate OAuth flow
authRouter.get('/oauth/:provider', requireGoogleSignIn, (req: Request, res: Response, next) => {
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
  requireGoogleSignIn,
  verifyOAuthState,
  passport.authenticate('google', {
    session: false,
    failureRedirect: `${frontendUrl()}/login?error=oauth_failed`,
  }),
  async (req: Request, res: Response) => {
    try {
      const returnTo = res.locals.returnTo as string;

      const oauthUser = req.user as OAuthUser;
      // Guest data only from a guest: a browser signed in to another account
      // must not hand that account's session to the sign-up.
      const guestSessionId = req.session?.isGuest ? req.session.id : null;
      const { accountId, isNew } = await resolveOAuthAccount(oauthUser, guestSessionId, returnTo);

      const existingToken = req.session?.token ?? null;
      const { signedToken, expiresAt } = await claimSession(accountId, existingToken);
      makeSessionCookie(signedToken, expiresAt, res);

      // Existing accounts: silent-discard guest gardens with zero plantings
      if (!isNew && guestSessionId) {
        await discardEmptyGuestGardens(guestSessionId);
      }

      res.redirect(`${frontendUrl()}${returnTo}`);
    } catch (err) {
      if (err instanceof OAuthTakeoverChoiceRequired) {
        res.cookie(TAKEOVER_COOKIE, err.browserToken, { ...TAKEOVER_COOKIE_OPTIONS, maxAge: TAKEOVER_MINUTES * 60 * 1000 });
        return res.redirect(`${frontendUrl()}/claim-account?token=${err.token}`);
      }
      if (err instanceof OAuthUnverifiedEmailError) {
        return res.redirect(`${frontendUrl()}/login?error=oauth_unverified`);
      }
      if (err instanceof OAuthLinkRequiresPasswordError) {
        return res.redirect(`${frontendUrl()}/login?error=oauth_link_password`);
      }
      if (err instanceof OAuthNotInvitedError) {
        return res.redirect(`${frontendUrl()}/private-beta?refused=1`);
      }
      logger.error('GET /auth/oauth/google/callback failed', err);
      res.redirect(`${frontendUrl()}/login?error=oauth_error`);
    }
  },
);

const INVALID_TAKEOVER = { error: 'This sign-in has expired. Please sign in with Google again.' };

// The held sign-in's browser half: the takeover only completes in the browser
// the Google callback came back to, so a /claim-account link alone (a leaked
// URL, or one an attacker got for their own Google sign-in) is useless.
const TAKEOVER_COOKIE = '_vernal_takeover';
const TAKEOVER_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: secureCookies(),
  path: '/api/auth/takeover',
};

function takeoverBrowserToken(req: Request): string | null {
  const value = req.cookies?.[TAKEOVER_COOKIE] as unknown;
  return typeof value === 'string' && value ? value : null;
}

// POST /api/auth/takeover/inspect { token }
// A Google sign-in held because it matched an unverified account: the address,
// so the page can ask whether the person created that account.
authRouter.post('/takeover/inspect', takeoverLimiter, async (req: Request, res: Response): Promise<void> => {
  const { token } = req.body as { token?: unknown };
  const pending =
    typeof token === 'string' && token ? await inspectOAuthTakeover(token, takeoverBrowserToken(req)) : null;
  if (!pending) {
    res.status(400).json(INVALID_TAKEOVER);
    return;
  }
  res.json({ data: { email: pending.email } });
});

// POST /api/auth/takeover { token, choice }
// Completes the held sign-in (single use) and signs the browser in as the
// callback would. 'mine' keeps the account (claimed, held at the Terms);
// 'not_mine' deletes it and makes a new account (see resolveAccount.ts).
authRouter.post('/takeover', takeoverLimiter, async (req: Request, res: Response): Promise<void> => {
  const { token, choice: rawChoice } = req.body as { token?: unknown; choice?: unknown };
  const choice = parseTakeoverChoice(rawChoice);
  if (choice === null || choice === 'invalid') {
    res.status(400).json(INVALID_CHOICE);
    return;
  }
  if (typeof token !== 'string' || !token) {
    res.status(400).json(INVALID_TAKEOVER);
    return;
  }
  let result: Awaited<ReturnType<typeof completeOAuthTakeover>>;
  try {
    result = await completeOAuthTakeover(token, takeoverBrowserToken(req), choice);
  } catch (err) {
    if (err instanceof OAuthTakeoverInvalidError) {
      res.status(400).json(INVALID_TAKEOVER);
      return;
    }
    if (err instanceof OAuthNotInvitedError) {
      res.status(403).json(NOT_INVITED);
      return;
    }
    if (err instanceof OAuthTakeoverChangedError) {
      res.status(409).json({ error: 'The account changed while you were deciding. Please sign in with Google again.' });
      return;
    }
    logger.error('POST /auth/takeover failed', err);
    res.status(502).json({ error: "We couldn't finish signing you in, so nothing was changed. Please try again." });
    return;
  }

  res.clearCookie(TAKEOVER_COOKIE, TAKEOVER_COOKIE_OPTIONS);
  const existingToken = req.session?.token ?? null;
  const { signedToken, expiresAt } = await claimSession(result.accountId, existingToken);
  makeSessionCookie(signedToken, expiresAt, res);
  if (!result.isNew && result.guestSessionId) {
    await discardEmptyGuestGardens(result.guestSessionId);
  }
  res.json({ data: { redirectTo: result.returnTo } });
});

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

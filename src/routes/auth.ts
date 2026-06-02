import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import {
  createGuestSession,
  makeSessionCookie,
  clearSessionCookie,
  claimSession,
} from '../lib/sessions';
import { db } from '../lib/db';
import { sendMail } from '../lib/mailer';

export const authRouter = Router();

// POST /api/auth/guest
// Creates a guest session for first-time visitors with no cookie.
// Idempotent from the client's perspective — if called with an existing valid session,
// we still honour the existing session (the middleware already populated req.session).
authRouter.post('/guest', async (req: Request, res: Response): Promise<void> => {
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
  makeSessionCookie(signedToken, expiresAt, res);

  res.status(201).json({
    data: {
      isGuest: true,
    },
  });
});

// GET /api/auth/session
// Returns the current session state. Used by the frontend on app load to determine
// whether the user is a guest, authenticated, or unauthenticated.
authRouter.get('/session', (req: Request, res: Response): void => {
  if (!req.session) {
    res.json({ data: { authenticated: false, isGuest: false } });
    return;
  }

  if (req.session.isGuest) {
    res.json({ data: { authenticated: false, isGuest: true } });
    return;
  }

  const { account } = req.session;
  res.json({
    data: {
      authenticated: true,
      isGuest: false,
      account: {
        id: account!.id,
        email: account!.email,
        role: account!.role,
        subscriptionTier: account!.subscriptionTier,
      },
    },
  });
});

// DELETE /api/auth/session
// Clears the session cookie. Guests lose their session; authenticated users are logged out.
// Does not delete the guest_sessions row — expired rows are cleaned up by the nightly job.
authRouter.delete('/session', (req: Request, res: Response): void => {
  clearSessionCookie(res);
  res.json({ data: { success: true } });
});

const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS ?? '12', 10);

// POST /api/auth/register
authRouter.post('/register', async (req: Request, res: Response): Promise<void> => {
  const { email, password } = req.body as { email?: string; password?: string };

  if (!email || !password) {
    res.status(400).json({ error: 'Email and password are required' });
    return;
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
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

  // Create the account
  // zone and zone_location_label are required fields — for registration they are set
  // to placeholder values and updated when the user completes onboarding
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO accounts (email, password_hash, zone, zone_location_label)
     VALUES ($1, $2, 'unknown', 'Not set')
     RETURNING id`,
    [email.toLowerCase(), passwordHash],
  );
  const accountId = rows[0].id;

  // Claim (or create) a session for the new account
  const existingToken = req.session?.token ?? null;
  const { signedToken, expiresAt } = await claimSession(accountId, existingToken);
  makeSessionCookie(signedToken, expiresAt, res);

  res.status(201).json({
    data: {
      authenticated: true,
      account: { id: accountId, email: email.toLowerCase() },
    },
  });
});

// POST /api/auth/login
authRouter.post('/login', async (req: Request, res: Response): Promise<void> => {
  const { email, password } = req.body as { email?: string; password?: string };

  if (!email || !password) {
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
     FROM accounts
     WHERE email = $1`,
    [email.toLowerCase()],
  );

  // Hash a dummy string on miss to prevent timing attacks
  const dummyHash = '$2b$12$invalidhashfordummycomparisononly.........';
  const hash = rows[0]?.password_hash ?? dummyHash;
  const valid = await bcrypt.compare(password, hash);

  if (!valid || rows.length === 0) {
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }

  const account = rows[0];

  // Update last_active_at
  await db.query(
    `UPDATE accounts SET last_active_at = now() WHERE id = $1
     AND (last_active_at IS NULL OR last_active_at < now() - interval '1 hour')`,
    [account.id],
  );

  const existingToken = req.session?.token ?? null;
  const { signedToken, expiresAt } = await claimSession(account.id, existingToken);
  makeSessionCookie(signedToken, expiresAt, res);

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
authRouter.post('/forgot-password', async (req: Request, res: Response): Promise<void> => {
  const { email } = req.body as { email?: string };

  if (!email) {
    res.status(400).json({ error: 'Email is required' });
    return;
  }

  // Always return 200 regardless of whether the email exists — prevents enumeration
  res.json({ data: { message: 'If an account with that email exists, a reset link has been sent.' } });

  // Do the work after responding
  const { rows } = await db.query<{ id: number }>(
    'SELECT id FROM accounts WHERE email = $1',
    [email.toLowerCase()],
  );
  if (rows.length === 0) return;

  const accountId = rows[0].id;
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = await bcrypt.hash(rawToken, 10);
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

  await db.query(
    `INSERT INTO password_reset_tokens (account_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [accountId, tokenHash, expiresAt],
  );

  const resetUrl = `${process.env.APP_URL ?? 'http://localhost:3000'}/reset-password?token=${rawToken}`;

  await sendMail({
    to: email.toLowerCase(),
    subject: 'Reset your Vernal password',
    text: `Click this link to reset your password (expires in 1 hour):\n\n${resetUrl}\n\nIf you didn't request this, you can ignore this email.`,
    html: `<p>Click this link to reset your password (expires in 1 hour):</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>If you didn't request this, you can ignore this email.</p>`,
  }).catch((err: Error) => console.error('[auth] Failed to send reset email:', err.message));
});

// POST /api/auth/reset-password
authRouter.post('/reset-password', async (req: Request, res: Response): Promise<void> => {
  const { token, password } = req.body as { token?: string; password?: string };

  if (!token || !password) {
    res.status(400).json({ error: 'Token and new password are required' });
    return;
  }

  if (password.length < 8) {
    res.status(400).json({ error: 'Password must be at least 8 characters' });
    return;
  }

  // Find valid, unused, unexpired tokens and compare
  const { rows } = await db.query<{ id: number; account_id: number; token_hash: string }>(
    `SELECT id, account_id, token_hash
     FROM password_reset_tokens
     WHERE expires_at > now() AND used_at IS NULL`,
  );

  let matchedRow: (typeof rows)[0] | null = null;
  for (const row of rows) {
    if (await bcrypt.compare(token, row.token_hash)) {
      matchedRow = row;
      break;
    }
  }

  if (!matchedRow) {
    res.status(400).json({ error: 'Invalid or expired reset token' });
    return;
  }

  const newHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  await db.query('BEGIN');
  try {
    await db.query('UPDATE accounts SET password_hash = $1 WHERE id = $2', [newHash, matchedRow.account_id]);
    await db.query('UPDATE password_reset_tokens SET used_at = now() WHERE id = $1', [matchedRow.id]);
    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }

  res.json({ data: { success: true, message: 'Password updated. You can now log in.' } });
});

import { Router } from 'express';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { db } from '../lib/db';
import { requireAuth } from '../middleware/auth';
import { clearSessionCookie } from '../lib/sessions';
import { sendMail } from '../lib/mailer';
import { logger } from '../lib/logger';
import { processExportJob } from '../lib/exportWorker';

const router = Router();
router.use(requireAuth);

const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS ?? '12', 10);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Fields that may never be updated via PATCH /api/me
const REJECTED_PATCH_FIELDS = new Set(['onboardingCompletedAt', 'email', 'role', 'subscriptionTier']);

interface AccountRow {
  id: string;
  email: string | null;
  pending_email: string | null;
  display_name: string | null;
  avatar_url: string | null;
  email_verified: boolean;
  zone: string;
  zone_location_label: string;
  last_spring_frost_date: string | null;
  first_fall_frost_date: string | null;
  role: string;
  subscription_tier: string;
  preferences: Record<string, unknown>;
  deletion_scheduled_at: string | null;
  supporter_prompt_shown: boolean;
  is_password_account: boolean;
  created_at: string;
  updated_at: string;
}

const ACCOUNT_SELECT = `
  id::text, email, pending_email, display_name, avatar_url, email_verified, zone,
  zone_location_label, last_spring_frost_date::text, first_fall_frost_date::text,
  role, subscription_tier, preferences, deletion_scheduled_at, supporter_prompt_shown,
  (password_hash IS NOT NULL) AS is_password_account, created_at, updated_at
`;

function formatAccount(row: AccountRow) {
  return {
    id: row.id,
    email: row.email,
    pendingEmail: row.pending_email,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    emailVerified: row.email_verified,
    zone: row.zone,
    zoneLocationLabel: row.zone_location_label,
    lastSpringFrostDate: row.last_spring_frost_date,
    firstFallFrostDate: row.first_fall_frost_date,
    role: row.role,
    subscriptionTier: row.subscription_tier,
    preferences: row.preferences ?? {},
    deletionScheduledAt: row.deletion_scheduled_at,
    supporterPromptShown: row.supporter_prompt_shown,
    isPasswordAccount: row.is_password_account,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function hashToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

// GET /api/me
router.get('/', async (req, res) => {
  try {
    const accountId = req.session!.account!.id;
    const { rows } = await db.query<AccountRow>(
      `SELECT ${ACCOUNT_SELECT} FROM accounts WHERE id = $1`,
      [accountId],
    );
    if (rows.length === 0) {
      clearSessionCookie(res);
      return res.status(401).json({ error: 'Account not found' });
    }
    res.json({ data: formatAccount(rows[0]) });
  } catch (err) {
    console.error('GET /me error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/me
// Updatable: displayName, zone, zoneLocationLabel, lastSpringFrostDate, firstFallFrostDate.
// Sending onboardingCompletedAt, email, role, or subscriptionTier yields 400.
// zone and zoneLocationLabel are NOT NULL — blank/empty values are rejected.
router.patch('/', async (req, res) => {
  const body = req.body as Record<string, unknown>;

  for (const field of REJECTED_PATCH_FIELDS) {
    if (field in body) {
      return res.status(400).json({ error: `${field} is not updatable` });
    }
  }

  const { displayName, zone, zoneLocationLabel, lastSpringFrostDate, firstFallFrostDate } = body;

  const updates: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (displayName !== undefined) {
    const trimmedName = typeof displayName === 'string' ? displayName.trim() : '';
    if (trimmedName.length === 0) {
      return res.status(400).json({ error: 'displayName cannot be blank' });
    }
    if (trimmedName.length > 60) {
      return res.status(400).json({ error: 'displayName must be 60 characters or fewer' });
    }
    updates.push(`display_name = $${idx++}`);
    values.push(trimmedName);
  }

  if (zone !== undefined) {
    if (typeof zone !== 'string' || zone.trim().length === 0) {
      return res.status(400).json({ error: 'zone cannot be blank' });
    }
    updates.push(`zone = $${idx++}`);
    values.push(zone.trim());
  }

  if (zoneLocationLabel !== undefined) {
    if (typeof zoneLocationLabel !== 'string' || zoneLocationLabel.trim().length === 0) {
      return res.status(400).json({ error: 'zoneLocationLabel cannot be blank' });
    }
    if (zoneLocationLabel.trim().length > 80) {
      return res.status(400).json({ error: 'zoneLocationLabel must be 80 characters or fewer' });
    }
    updates.push(`zone_location_label = $${idx++}`);
    values.push(zoneLocationLabel.trim());
  }

  if (lastSpringFrostDate !== undefined) {
    if (lastSpringFrostDate !== null) {
      if (
        typeof lastSpringFrostDate !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(lastSpringFrostDate)
      ) {
        return res
          .status(400)
          .json({ error: 'lastSpringFrostDate must be YYYY-MM-DD or null' });
      }
    }
    updates.push(`last_spring_frost_date = $${idx++}`);
    values.push(lastSpringFrostDate);
  }

  if (firstFallFrostDate !== undefined) {
    if (firstFallFrostDate !== null) {
      if (
        typeof firstFallFrostDate !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(firstFallFrostDate)
      ) {
        return res
          .status(400)
          .json({ error: 'firstFallFrostDate must be YYYY-MM-DD or null' });
      }
    }
    updates.push(`first_fall_frost_date = $${idx++}`);
    values.push(firstFallFrostDate);
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'No fields to update' });
  }

  updates.push(`updated_at = NOW()`);
  values.push(req.session!.account!.id);

  try {
    const { rows } = await db.query<AccountRow>(
      `UPDATE accounts SET ${updates.join(', ')} WHERE id = $${idx} RETURNING ${ACCOUNT_SELECT}`,
      values,
    );
    if (rows.length === 0) {
      clearSessionCookie(res);
      return res.status(401).json({ error: 'Account not found' });
    }
    res.json({ data: formatAccount(rows[0]) });
  } catch (err) {
    console.error('PATCH /me error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/me/preferences
// Merges the body object into the stored preferences JSONB using jsonb_strip_nulls + ||.
// A null value for a key removes that key from the stored object.
router.patch('/preferences', async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ error: 'Body must be a JSON object' });
  }

  try {
    const { rows } = await db.query<{ preferences: Record<string, unknown> }>(
      `UPDATE accounts
       SET preferences = jsonb_strip_nulls(COALESCE(preferences, '{}') || $1::jsonb),
           updated_at = NOW()
       WHERE id = $2
       RETURNING preferences`,
      [JSON.stringify(body), req.session!.account!.id],
    );
    if (rows.length === 0) {
      clearSessionCookie(res);
      return res.status(401).json({ error: 'Account not found' });
    }
    res.json({ data: { preferences: rows[0].preferences } });
  } catch (err) {
    console.error('PATCH /me/preferences error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/me/password
router.patch('/password', async (req, res) => {
  const { currentPassword, newPassword } = req.body as {
    currentPassword?: unknown;
    newPassword?: unknown;
  };

  if (!currentPassword || typeof currentPassword !== 'string') {
    return res.status(400).json({ error: 'currentPassword is required' });
  }
  if (!newPassword || typeof newPassword !== 'string') {
    return res.status(400).json({ error: 'newPassword is required' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'newPassword must be at least 8 characters' });
  }

  const accountId = req.session!.account!.id;
  const sessionToken = req.session!.token;

  try {
    const { rows } = await db.query<{ password_hash: string | null }>(
      'SELECT password_hash FROM accounts WHERE id = $1',
      [accountId],
    );

    if (rows.length === 0) {
      clearSessionCookie(res);
      return res.status(401).json({ error: 'Account not found' });
    }

    if (!rows[0].password_hash) {
      return res
        .status(400)
        .json({ error: 'This account uses OAuth login and does not have a password' });
    }

    const match = await bcrypt.compare(currentPassword, rows[0].password_hash);
    if (!match) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }

    const newHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'UPDATE accounts SET password_hash = $1, updated_at = NOW() WHERE id = $2',
        [newHash, accountId],
      );
      // Invalidate all other sessions for this account; the current session survives.
      await client.query(
        'DELETE FROM guest_sessions WHERE account_id = $1 AND token <> $2',
        [accountId, sessionToken],
      );
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }

    res.json({ data: { message: 'Password updated' } });
  } catch (err) {
    console.error('PATCH /me/password error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/me/email
// Starts an email change: stores a hashed confirmation token and emails the
// raw token to the new address. The account's email column is untouched
// until GET /email/confirm succeeds.
router.patch('/email', async (req, res) => {
  const { newEmail } = req.body as { newEmail?: unknown };
  const accountId = req.session!.account!.id;

  if (typeof newEmail !== 'string' || !EMAIL_RE.test(newEmail)) {
    return res.status(400).json({ error: 'Invalid email address.' });
  }
  const normalizedEmail = newEmail.toLowerCase();

  try {
    const { rows } = await db.query<{ email: string; password_hash: string | null }>(
      'SELECT email, password_hash FROM accounts WHERE id = $1',
      [accountId],
    );
    if (rows.length === 0) {
      clearSessionCookie(res);
      return res.status(401).json({ error: 'Account not found' });
    }

    if (!rows[0].password_hash) {
      return res
        .status(400)
        .json({ error: 'Email change is not available for accounts using OAuth sign-in.' });
    }

    if (normalizedEmail === rows[0].email.toLowerCase()) {
      return res.status(400).json({ error: 'New email is the same as your current email.' });
    }

    const { rows: conflicting } = await db.query(
      'SELECT id FROM accounts WHERE (email = $1 OR pending_email = $1) AND id <> $2',
      [normalizedEmail, accountId],
    );
    if (conflicting.length > 0) {
      return res.status(409).json({ error: 'That email address is already in use.' });
    }

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashToken(rawToken);

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'DELETE FROM email_change_tokens WHERE account_id = $1 AND used_at IS NULL',
        [accountId],
      );
      await client.query(
        `INSERT INTO email_change_tokens (account_id, token_hash, new_email, expires_at)
         VALUES ($1, $2, $3, NOW() + INTERVAL '24 hours')`,
        [accountId, tokenHash, normalizedEmail],
      );
      await client.query(
        'UPDATE accounts SET pending_email = $1, updated_at = NOW() WHERE id = $2',
        [normalizedEmail, accountId],
      );
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }

    const confirmUrl = `${process.env.FRONTEND_URL}/account/email/confirm?token=${rawToken}`;
    await sendMail({
      to: normalizedEmail,
      subject: 'Confirm your new email address',
      text: `Someone requested a change to the email address on your Vernal account.\n\nClick the link below to confirm. It expires in 24 hours.\n\n${confirmUrl}\n\nIf you did not request this, you can safely ignore this email.`,
      html: `<p>Someone requested a change to the email address on your Vernal account.</p><p>Click the link below to confirm. It expires in 24 hours.</p><p><a href="${confirmUrl}">${confirmUrl}</a></p><p>If you did not request this, you can safely ignore this email.</p>`,
    });

    res.json({ data: { pendingEmail: normalizedEmail } });
  } catch (err) {
    console.error('PATCH /me/email error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/me/email
// Cancels an in-flight email change.
router.delete('/email', async (req, res) => {
  const accountId = req.session!.account!.id;

  try {
    await db.query(
      'UPDATE accounts SET pending_email = NULL, updated_at = NOW() WHERE id = $1',
      [accountId],
    );
    await db.query(
      'DELETE FROM email_change_tokens WHERE account_id = $1 AND used_at IS NULL',
      [accountId],
    );
    res.json({ data: { pendingEmail: null } });
  } catch (err) {
    console.error('DELETE /me/email error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/me/email/confirm
// Completes an email change. The token must belong to the currently
// authenticated account — this prevents a leaked/shared confirmation link
// from being redeemed onto a different, attacker-controlled account.
router.get('/email/confirm', async (req, res) => {
  const token = req.query.token as string | undefined;
  const accountId = req.session!.account!.id;

  if (!token) {
    return res.status(400).json({ error: 'Token is required.' });
  }

  const invalidError = { error: 'This confirmation link is invalid or has expired.' };

  try {
    const tokenHash = hashToken(token);
    const { rows } = await db.query<{
      id: number;
      account_id: number;
      new_email: string;
    }>(
      `SELECT id, account_id, new_email FROM email_change_tokens
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()`,
      [tokenHash],
    );

    if (rows.length === 0 || rows[0].account_id !== accountId) {
      return res.status(400).json(invalidError);
    }
    const matchedToken = rows[0];

    const { rows: conflicting } = await db.query(
      'SELECT id FROM accounts WHERE email = $1 AND id <> $2',
      [matchedToken.new_email, accountId],
    );
    if (conflicting.length > 0) {
      return res.status(409).json({ error: 'That email address was taken before you could confirm.' });
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'UPDATE accounts SET email = $1, pending_email = NULL, updated_at = NOW() WHERE id = $2',
        [matchedToken.new_email, accountId],
      );
      await client.query(
        'UPDATE email_change_tokens SET used_at = NOW() WHERE id = $1',
        [matchedToken.id],
      );
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }

    res.json({ data: { email: matchedToken.new_email } });
  } catch (err) {
    console.error('GET /me/email/confirm error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/me
// Schedules account deletion by setting deletion_scheduled_at.
// COALESCE ensures re-requesting does NOT reset the 30-day clock.
// The current session row is deleted immediately; the data purge runs
// via the nightly job 30 days after deletion_scheduled_at.
router.delete('/', async (req, res) => {
  const accountId = req.session!.account!.id;
  const sessionToken = req.session!.token;

  try {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE accounts
         SET deletion_scheduled_at = COALESCE(deletion_scheduled_at, NOW()),
             updated_at = NOW()
         WHERE id = $1`,
        [accountId],
      );
      await client.query('DELETE FROM guest_sessions WHERE token = $1', [sessionToken]);
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }
    clearSessionCookie(res);

    res.status(204).send();
  } catch (err) {
    console.error('DELETE /me error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/me/cancel-deletion
// Clears deletion_scheduled_at. Idempotent — safe to call when nothing is scheduled.
router.post('/cancel-deletion', async (req, res) => {
  const accountId = req.session!.account!.id;

  try {
    await db.query(
      'UPDATE accounts SET deletion_scheduled_at = NULL, updated_at = NOW() WHERE id = $1',
      [accountId],
    );
    res.json({ data: { deletionScheduledAt: null } });
  } catch (err) {
    console.error('POST /me/cancel-deletion error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/me/supporter-prompt/shown
// Marks the one-time Supporter prompt as shown. One-way — idempotent, no unset endpoint.
router.post('/supporter-prompt/shown', async (req, res) => {
  const accountId = req.session!.account!.id;

  try {
    await db.query(
      'UPDATE accounts SET supporter_prompt_shown = true, updated_at = NOW() WHERE id = $1',
      [accountId],
    );
    res.json({ data: { supporterPromptShown: true } });
  } catch (err) {
    console.error('POST /me/supporter-prompt/shown error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// A pending/processing export older than this is assumed dead (server restart
// mid-job, or a crash before processExportJob ran) and is marked failed.
const EXPORT_STALE_MINUTES = 15;

async function failStaleExportJobs(
  q: { query: typeof db.query },
  accountId: number,
): Promise<void> {
  const { rows } = await q.query<{ id: number }>(
    `UPDATE data_export_jobs SET status = 'failed'
     WHERE account_id = $1
       AND status IN ('pending', 'processing')
       AND requested_at < now() - make_interval(mins => $2)
     RETURNING id`,
    [accountId, EXPORT_STALE_MINUTES],
  );
  for (const { id } of rows) {
    logger.warn('Marked stale export job failed', { jobId: id, accountId });
  }
}

// POST /api/me/export
// Starts a data export. Returns the existing download while an unexpired
// export exists; otherwise queues a job and processes it in the background.
router.post('/export', async (req, res) => {
  const accountId = req.session!.account!.id;

  try {
    let jobId: number;
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      // Serialises concurrent requests from the same account so only one job is queued.
      await client.query('SELECT 1 FROM accounts WHERE id = $1 FOR UPDATE', [accountId]);
      await failStaleExportJobs(client, accountId);

      const { rows: active } = await client.query(
        `SELECT 1 FROM data_export_jobs
         WHERE account_id = $1 AND status IN ('pending', 'processing')
         LIMIT 1`,
        [accountId],
      );
      if (active.length > 0) {
        await client.query('COMMIT');
        return res.status(409).json({ error: 'An export is already in progress.' });
      }

      const { rows: ready } = await client.query<{ download_url: string; expires_at: Date }>(
        `SELECT download_url, expires_at FROM data_export_jobs
         WHERE account_id = $1 AND status = 'complete' AND expires_at > now()
         ORDER BY expires_at DESC
         LIMIT 1`,
        [accountId],
      );
      if (ready.length > 0) {
        await client.query('COMMIT');
        return res.status(200).json({
          data: {
            status: 'complete',
            downloadUrl: ready[0].download_url,
            expiresAt: ready[0].expires_at,
          },
        });
      }

      const { rows: inserted } = await client.query<{ id: number }>(
        `INSERT INTO data_export_jobs (account_id, status) VALUES ($1, 'pending') RETURNING id`,
        [accountId],
      );
      jobId = inserted[0].id;
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }

    // Deliberately not awaited — processExportJob never throws.
    void processExportJob(jobId);

    res.status(202).json({ data: { jobId, status: 'pending' } });
  } catch (err) {
    logger.error('POST /me/export error', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/me/export
// The account's most recent export job.
router.get('/export', async (req, res) => {
  const accountId = req.session!.account!.id;

  try {
    await failStaleExportJobs(db, accountId);
    const { rows } = await db.query<{
      id: number;
      status: string;
      requested_at: Date;
      completed_at: Date | null;
      download_url: string | null;
      expires_at: Date | null;
      expired: boolean;
    }>(
      `SELECT id, status, requested_at, completed_at, download_url, expires_at,
              COALESCE(status = 'complete' AND expires_at <= now(), false) AS expired
       FROM data_export_jobs
       WHERE account_id = $1
       ORDER BY requested_at DESC, id DESC
       LIMIT 1`,
      [accountId],
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'No export requested.' });
    }

    const job = rows[0];
    res.json({
      data: {
        jobId: job.id,
        status: job.status,
        requestedAt: job.requested_at,
        completedAt: job.completed_at,
        downloadUrl: job.expired ? null : job.download_url,
        expiresAt: job.expires_at,
        expired: job.expired,
      },
    });
  } catch (err) {
    logger.error('GET /me/export error', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;

import { Router } from 'express';
import bcrypt from 'bcrypt';
import { db } from '../lib/db';
import { requireAuth } from '../middleware/auth';
import { clearSessionCookie } from '../lib/sessions';

const router = Router();
router.use(requireAuth);

const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS ?? '12', 10);

// Fields that may never be updated via PATCH /api/me
const REJECTED_PATCH_FIELDS = new Set(['onboardingCompletedAt', 'email', 'role', 'subscriptionTier']);

interface AccountRow {
  id: string;
  email: string | null;
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
  created_at: string;
  updated_at: string;
}

const ACCOUNT_SELECT = `
  id::text, email, display_name, avatar_url, email_verified, zone,
  zone_location_label, last_spring_frost_date::text, first_fall_frost_date::text,
  role, subscription_tier, preferences, deletion_scheduled_at,
  created_at, updated_at
`;

function formatAccount(row: AccountRow) {
  return {
    id: row.id,
    email: row.email,
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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

export default router;

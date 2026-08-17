import { Router } from 'express';
import { db } from '../lib/db';
import { requireAdmin } from '../middleware/auth';
import { isNumericId } from '../lib/validation';

const router = Router();
router.use(requireAdmin);

const ACCOUNT_LIST_COLUMNS = `
  id, email, display_name, role, subscription_tier, subscription_interval,
  subscription_period_end, last_active_at, created_at
`;

// ── GET /stats ───────────────────────────────────────────────────────────────

router.get('/stats', async (_req, res) => {
  try {
    const [accountsResult, subscriptionsResult] = await Promise.all([
      db.query(`
        SELECT
          COUNT(*)::int                                                    AS total,
          COUNT(*) FILTER (WHERE created_at > now() - interval '30 days')::int
                                                                            AS new_last_30d,
          COUNT(*) FILTER (WHERE created_at > now() - interval '7 days')::int
                                                                            AS new_last_7d,
          COUNT(*) FILTER (WHERE last_active_at > now() - interval '30 days')::int
                                                                            AS active_last_30d
        FROM accounts
      `),
      db.query(`
        SELECT subscription_tier, COUNT(*)::int AS count
        FROM accounts
        GROUP BY subscription_tier
        ORDER BY count DESC
      `),
    ]);

    res.json({
      accounts: accountsResult.rows[0],
      subscriptions: subscriptionsResult.rows,
    });
  } catch (err) {
    console.error('GET /admin/stats error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /accounts ────────────────────────────────────────────────────────────

router.get('/accounts', async (req, res) => {
  try {
    const email = req.query.email as string | undefined;

    if (email) {
      const result = await db.query(
        `SELECT ${ACCOUNT_LIST_COLUMNS} FROM accounts WHERE email ILIKE $1 ORDER BY created_at DESC LIMIT 20`,
        [`%${email}%`],
      );
      res.json({ data: result.rows });
      return;
    }

    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = 50;
    const offset = (page - 1) * limit;

    const [dataResult, countResult] = await Promise.all([
      db.query(
        `SELECT ${ACCOUNT_LIST_COLUMNS} FROM accounts ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
        [limit, offset],
      ),
      db.query('SELECT COUNT(*)::int AS total FROM accounts'),
    ]);

    res.json({ data: dataResult.rows, page, total: countResult.rows[0].total });
  } catch (err) {
    console.error('GET /admin/accounts error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /accounts/:id ─────────────────────────────────────────────────────────

router.get('/accounts/:id', async (req, res) => {
  try {
    const rawId = req.params.id as string;
    if (!isNumericId(rawId)) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const id = parseInt(rawId, 10);

    const [accountResult, gardenCountResult] = await Promise.all([
      db.query(
        `SELECT id, email, display_name, zone, zone_location_label, role,
                subscription_tier, stripe_customer_id, stripe_subscription_id,
                subscription_interval, subscription_period_end,
                subscription_cancelled_at, last_active_at, created_at, updated_at
         FROM accounts WHERE id = $1`,
        [id],
      ),
      db.query('SELECT COUNT(*)::int AS garden_count FROM gardens WHERE owner_id = $1', [id]),
    ]);

    if (accountResult.rows.length === 0) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    res.json({
      ...accountResult.rows[0],
      gardenCount: gardenCountResult.rows[0].garden_count,
    });
  } catch (err) {
    console.error('GET /admin/accounts/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;

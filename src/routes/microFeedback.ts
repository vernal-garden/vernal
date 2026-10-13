import { Router, Request, Response } from 'express';
import { db } from '../lib/db';
import { sendMail } from '../lib/mailer';
import { logger } from '../lib/logger';
import { isNumericId } from '../lib/validation';
import { isMicroFeedbackTrigger, MICRO_FEEDBACK_TRIGGERS } from '../lib/eventKeys';
import { requireAuth } from '../middleware/auth';
import { writeLimiter } from '../middleware/rateLimiters';
import type { SessionData } from '../types';

// Contextual micro-feedback prompts (Feedback Pipeline spec surface 3.2).
// Accounts only. Each trigger is shown at most once per account (the mf_* flag)
// and answered at most once.
const router = Router();
router.use(requireAuth, writeLimiter);

const THUMBS = ['thumbs_up', 'thumbs_down'] as const;
const TEXT_MAX = 2000;

const PACIFIC_TIME = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  dateStyle: 'medium',
  timeStyle: 'short',
});

type Trigger = (typeof MICRO_FEEDBACK_TRIGGERS)[number];

// The flag column always comes from this lookup, never from the request.
function triggerFor(value: unknown): Trigger | null {
  if (!isMicroFeedbackTrigger(value)) return null;
  return MICRO_FEEDBACK_TRIGGERS.find((t) => t.triggerKey === value) ?? null;
}

function trimmedText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= TEXT_MAX ? trimmed : null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function notify(triggerKey: string, response: string, email: string): void {
  const to = process.env.FEEDBACK_NOTIFY_EMAIL;
  if (!to) return;

  const when = `${PACIFIC_TIME.format(new Date())} Pacific`;
  const subject = `Vernal micro-feedback: ${triggerKey}`;
  const text = [response, '', `From: ${email}`, `Time: ${when}`].join('\n');
  const html = `
    <p style="white-space: pre-wrap">${escapeHtml(response)}</p>
    <hr>
    <p>
      From: ${escapeHtml(email)}<br>
      Time: ${escapeHtml(when)}
    </p>
  `;

  try {
    sendMail({ to, subject, text, html }).catch((err: unknown) => {
      logger.warn('Micro-feedback notification email failed', {
        triggerKey,
        errMsg: err instanceof Error ? err.message : String(err),
      });
    });
  } catch (err) {
    logger.warn('Micro-feedback notification email failed', {
      triggerKey,
      errMsg: err instanceof Error ? err.message : String(err),
    });
  }
}

// POST /api/micro-feedback/shown — claims the prompt. show is true only for the
// first call per account and trigger.
router.post('/shown', async (req: Request, res: Response) => {
  const session = req.session as SessionData;
  const trigger = triggerFor(req.body?.triggerKey);
  if (!trigger) return res.status(400).json({ error: 'Unknown trigger.' });

  try {
    const result = await db.query(
      `UPDATE accounts SET ${trigger.flag} = true, updated_at = now()
       WHERE id = $1 AND ${trigger.flag} = false
       RETURNING id`,
      [session.account!.id],
    );
    return res.json({ show: result.rowCount === 1 });
  } catch (err) {
    logger.error('POST /api/micro-feedback/shown failed', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/micro-feedback — the answer to a shown prompt.
router.post('/', async (req: Request, res: Response) => {
  const session = req.session as SessionData;
  const account = session.account!;
  const trigger = triggerFor(req.body?.triggerKey);
  if (!trigger) return res.status(400).json({ error: 'Unknown trigger.' });

  const raw: unknown = req.body?.response;
  let response: string | null;
  if (trigger.responseType === 'thumbs') {
    response = (THUMBS as readonly unknown[]).includes(raw) ? (raw as string) : null;
    if (!response) {
      return res.status(400).json({ error: 'response must be thumbs_up or thumbs_down.' });
    }
  } else {
    response = trimmedText(raw);
    if (!response) {
      return res.status(400).json({ error: `response must be 1 to ${TEXT_MAX} characters.` });
    }
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Locking the account row serializes answers, so two requests can't both
    // pass the "already answered" check.
    const { rows } = await client.query<{ shown: boolean }>(
      `SELECT ${trigger.flag} AS shown FROM accounts WHERE id = $1 FOR UPDATE`,
      [account.id],
    );
    if (!rows[0]?.shown) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Prompt not shown.' });
    }

    const existing = await client.query(
      'SELECT 1 FROM micro_feedback_responses WHERE account_id = $1 AND trigger_key = $2',
      [account.id, trigger.triggerKey],
    );
    if ((existing.rowCount ?? 0) > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Already answered.' });
    }

    const { rows: inserted } = await client.query<{ id: number }>(
      `INSERT INTO micro_feedback_responses (account_id, trigger_key, response)
       VALUES ($1, $2, $3) RETURNING id`,
      [account.id, trigger.triggerKey, response],
    );
    await client.query('COMMIT');

    res.status(201).json({ id: inserted[0].id });
    notify(trigger.triggerKey, response, account.email);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    logger.error('POST /api/micro-feedback failed', err);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// PATCH /api/micro-feedback/:id — the optional comment after a thumbs answer.
router.patch('/:id', async (req: Request, res: Response) => {
  const session = req.session as SessionData;
  const account = session.account!;
  const id = req.params.id as string;
  if (!isNumericId(id)) return res.status(400).json({ error: 'Invalid id' });

  try {
    const { rows } = await db.query<{ trigger_key: string; response: string }>(
      'SELECT trigger_key, response FROM micro_feedback_responses WHERE id = $1 AND account_id = $2',
      [id, account.id],
    );
    const row = rows[0];
    if (!row) return res.status(404).json({ error: 'Response not found.' });

    const trigger = triggerFor(row.trigger_key);
    if (!trigger || trigger.responseType !== 'thumbs') {
      return res.status(400).json({ error: 'Comments are for thumbs prompts.' });
    }
    if (!(THUMBS as readonly string[]).includes(row.response)) {
      return res.status(409).json({ error: 'Already commented.' });
    }

    const comment = trimmedText(req.body?.comment);
    if (!comment) {
      return res.status(400).json({ error: `comment must be 1 to ${TEXT_MAX} characters.` });
    }

    // The response guard makes a concurrent second comment a no-op.
    const { rows: updated } = await db.query<{ response: string }>(
      `UPDATE micro_feedback_responses
       SET response = response || E'\\n\\n' || $3
       WHERE id = $1 AND account_id = $2 AND response IN ('thumbs_up', 'thumbs_down')
       RETURNING response`,
      [id, account.id, comment],
    );
    if (updated.length === 0) return res.status(409).json({ error: 'Already commented.' });

    res.json({ id: Number(id) });
    notify(trigger.triggerKey, updated[0].response, account.email);
  } catch (err) {
    logger.error('PATCH /api/micro-feedback/:id failed', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;

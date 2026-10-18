import { Router, Request, Response } from 'express';
import { db } from '../lib/db';
import { sendMail } from '../lib/mailer';
import { logger } from '../lib/logger';
import { writeLimiter, feedbackSessionLimiter, feedbackIpLimiter } from '../middleware/rateLimiters';
import { requireSession } from '../middleware/auth';

const feedbackRouter = Router();

// 'data_quality' is a valid DB value but reserved — not accepted from the widget.
const CATEGORIES = ['bug', 'feature_request', 'general'] as const;
type Category = (typeof CATEGORIES)[number];

const CATEGORY_LABELS: Record<Category, string> = {
  bug: 'Bug',
  feature_request: 'Idea',
  general: 'Other',
};

const MESSAGE_MIN = 10;
const MESSAGE_MAX = 5000;
const META_MAX = 64;

// Notification emails per rolling hour across all senders. Past this, feedback
// is still saved (and visible in admin) but the owner isn't emailed.
const EMAIL_BUDGET_PER_HOUR = 20;

async function withinEmailBudget(): Promise<boolean> {
  try {
    const { rows } = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM feedback_submissions WHERE created_at > NOW() - INTERVAL '1 hour'`,
    );
    if (rows[0].n <= EMAIL_BUDGET_PER_HOUR) return true;
    logger.warn('Feedback email budget reached; notification skipped');
    return false;
  } catch (err) {
    logger.warn('Feedback email budget check failed; skipping email', {
      errMsg: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

function optionalMeta(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().slice(0, META_MAX);
  return trimmed.length > 0 ? trimmed : null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface NotifyParams {
  to: string;
  id: number;
  category: Category;
  message: string;
  sender: string;
  sourceSurface: string | null;
  appVersion: string | null;
}

function notify(p: NotifyParams): void {
  const surface = p.sourceSurface ?? 'unknown';
  const version = p.appVersion ?? 'unknown';
  const subject = `Vernal feedback: ${CATEGORY_LABELS[p.category]} — ${surface}`;

  const text = [
    p.message,
    '',
    `From: ${p.sender}`,
    `Source surface: ${surface}`,
    `App version: ${version}`,
    `Submission id: ${p.id}`,
  ].join('\n');

  const html = `
    <p style="white-space: pre-wrap">${escapeHtml(p.message)}</p>
    <hr>
    <p>
      From: ${escapeHtml(p.sender)}<br>
      Source surface: ${escapeHtml(surface)}<br>
      App version: ${escapeHtml(version)}<br>
      Submission id: ${p.id}
    </p>
  `;

  sendMail({ to: p.to, subject, text, html }).catch((err: unknown) => {
    logger.warn('Feedback notification email failed', {
      submissionId: p.id,
      errMsg: err instanceof Error ? err.message : String(err),
    });
  });
}

// POST /api/feedback — persistent feedback widget (surface 3.1). Guests allowed,
// but a session is required so per-session limits apply.
feedbackRouter.post(
  '/',
  requireSession,
  feedbackSessionLimiter,
  feedbackIpLimiter,
  writeLimiter,
  async (req: Request, res: Response) => {
    const { category, message } = req.body ?? {};

    if (!CATEGORIES.includes(category)) {
      res.status(400).json({ error: 'Invalid category.' });
      return;
    }

    const trimmed = typeof message === 'string' ? message.trim() : '';
    if (trimmed.length < MESSAGE_MIN || trimmed.length > MESSAGE_MAX) {
      res.status(400).json({ error: 'Message must be between 10 and 5000 characters.' });
      return;
    }

    const sourceSurface = optionalMeta(req.body.sourceSurface);
    const appVersion = optionalMeta(req.body.appVersion);
    const account = req.session?.account ?? null;

    const { rows } = await db.query<{ id: number }>(
      `INSERT INTO feedback_submissions (user_id, category, message, source_surface, app_version)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [account?.id ?? null, category, trimmed, sourceSurface, appVersion],
    );
    const id = rows[0].id;

    // The count includes the row just inserted, so the 20th submission in an
    // hour is the last one emailed.
    const to = process.env.FEEDBACK_NOTIFY_EMAIL;
    const sendEmail = to ? await withinEmailBudget() : false;

    res.status(201).json({ id });

    if (to && sendEmail) {
      notify({
        to,
        id,
        category: category as Category,
        message: trimmed,
        sender: account?.email ?? 'Guest (not logged in)',
        sourceSurface,
        appVersion,
      });
    }
  },
);

export default feedbackRouter;

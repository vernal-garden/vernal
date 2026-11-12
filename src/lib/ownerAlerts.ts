import type { PoolClient } from 'pg';
import { db } from './db';
import { logger } from './logger';
import { sendMail } from './mailer';

export type OwnerEventKind =
  | 'account_created'
  | 'not_me'
  | 'takeover'
  | 'deletion_scheduled'
  | 'deletion_cancelled'
  | 'subscription_started'
  | 'lifetime_purchased'
  | 'subscription_cancelled'
  | 'refund'
  | 'dispute'
  | 'beta_terms_accepted';

// Kind and time only. Pass the transaction's client to record inside it.
export async function recordOwnerEvent(kind: OwnerEventKind, client?: PoolClient): Promise<void> {
  await (client ?? db).query('INSERT INTO owner_events (kind) VALUES ($1)', [kind]);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function alertRecipient(): string | undefined {
  return process.env.ALERT_EMAIL_TO?.trim() || process.env.FEEDBACK_NOTIFY_EMAIL?.trim() || undefined;
}

export type OwnerAlertLink = { label: string; path: string };
// A line with its own link renders as "text — URL" in text and as text plus an <a> in html.
export type OwnerAlertLine = string | { text: string; link: OwnerAlertLink };

function appUrl(path: string): string {
  return (process.env.FRONTEND_URL ?? 'http://localhost:5173') + path;
}

// Never throws. Alert text holds counts, plan names, amounts and admin links, nothing personal.
export async function sendOwnerAlert(opts: {
  kind: string;
  subject: string;
  lines: OwnerAlertLine[];
  link?: OwnerAlertLink;
}): Promise<void> {
  try {
    const to = alertRecipient();
    if (!to) return;

    const subject = `[Vernal app] ${opts.subject}`.replace(/[\r\n\0]/g, '');
    const textParts: string[] = [];
    const htmlParts: string[] = [];
    for (const l of opts.lines) {
      if (typeof l === 'string') {
        textParts.push(l);
        htmlParts.push(`<p>${escapeHtml(l)}</p>`);
      } else {
        const url = appUrl(l.link.path);
        textParts.push(`${l.text} — ${url}`);
        htmlParts.push(
          `<p>${escapeHtml(l.text)} <a href="${escapeHtml(url)}">${escapeHtml(l.link.label)}</a></p>`,
        );
      }
    }
    if (opts.link) {
      const url = appUrl(opts.link.path);
      textParts.push(`${opts.link.label}: ${url}`);
      htmlParts.push(`<p><a href="${escapeHtml(url)}">${escapeHtml(opts.link.label)}</a></p>`);
    }

    await sendMail({ to, subject, text: textParts.join('\n\n'), html: htmlParts.join('\n') });
  } catch (err) {
    logger.warn('Owner alert failed', { kind: opts.kind, errCode: errCodeOf(err) });
  }
}

function errCodeOf(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : err instanceof Error ? err.name : null;
}

// Call after the new account has committed. Never throws.
export async function alertNewAccount(method: 'email' | 'Google'): Promise<void> {
  // Read at call time, so the setting can change without a restart.
  if (process.env.ALERT_INSTANT_SIGNUPS?.trim().toLowerCase() === 'false' || !alertRecipient()) return;
  let total: number;
  try {
    const { rows } = await db.query<{ n: string }>('SELECT COUNT(*) AS n FROM accounts');
    total = Number(rows[0].n);
  } catch (err) {
    logger.warn('Owner alert failed', { kind: 'account_created', errCode: errCodeOf(err) });
    return;
  }
  await sendOwnerAlert({
    kind: 'account_created',
    subject: 'New account',
    lines: [`Someone made a Vernal account (${method}).`, `Accounts: ${total} total.`],
    link: { label: 'Open users', path: '/admin/users' },
  });
}

const pacificFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: 'numeric',
  hourCycle: 'h23',
});

export function pacificParts(d: Date): { date: string; hour: number } {
  const p: Record<string, string> = {};
  for (const part of pacificFormat.formatToParts(d)) p[part.type] = part.value;
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 };
}

export function formatUsd(cents: number, currency: string): string {
  const amount = (cents / 100).toFixed(2);
  return currency.toLowerCase() === 'usd' ? `$${amount}` : `${amount} ${currency.toUpperCase()}`;
}

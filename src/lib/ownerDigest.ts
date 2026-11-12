import cron from 'node-cron';
import { db } from './db';
import { logger } from './logger';
import { pacificParts, sendOwnerAlert, type OwnerAlertLine, type OwnerEventKind } from './ownerAlerts';

// Daily owner digest. Counts, dates and admin links only: never an email
// address, name, id or any other row content.

function readDigestHour(): number {
  const raw = process.env.ALERT_DIGEST_HOUR?.trim();
  if (raw === undefined || raw === '') return 7;
  if (!/^\d{1,2}$/.test(raw) || Number(raw) > 23) {
    throw new Error('ALERT_DIGEST_HOUR must be a whole number from 0 to 23');
  }
  return Number(raw);
}

const DIGEST_HOUR = readDigestHour();

const DAY_MS = 24 * 60 * 60 * 1000;

const subjectDateFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  weekday: 'long',
  month: 'long',
  day: 'numeric',
});

interface Counts {
  events: Partial<Record<OwnerEventKind, number>>;
  accounts: number;
  monthly: number;
  annual: number;
  lifetime: number;
  corrections: number;
  newSeeds: number;
}

// Only COUNTs are selected, so no row content can reach the email.
async function loadCounts(start: Date, end: Date): Promise<Counts> {
  const [events, now] = await Promise.all([
    db.query<{ kind: OwnerEventKind; n: number }>(
      `SELECT kind, COUNT(*)::int AS n FROM owner_events
        WHERE occurred_at > $1 AND occurred_at <= $2 GROUP BY kind`,
      [start, end],
    ),
    db.query<{
      accounts: number;
      monthly: number;
      annual: number;
      lifetime: number;
      corrections: number;
      new_seeds: number;
    }>(`
      SELECT
        (SELECT COUNT(*)::int FROM accounts) AS accounts,
        (SELECT COUNT(*)::int FROM accounts
          WHERE subscription_tier = 'supporter' AND subscription_interval = 'monthly') AS monthly,
        (SELECT COUNT(*)::int FROM accounts
          WHERE subscription_tier = 'supporter' AND subscription_interval = 'annual') AS annual,
        (SELECT COUNT(*)::int FROM accounts
          WHERE subscription_tier = 'supporter' AND subscription_interval = 'lifetime') AS lifetime,
        (SELECT COUNT(*)::int FROM moderation_items
          WHERE type = 'correction' AND status IN ('new', 'under_review')) AS corrections,
        (SELECT COUNT(*)::int FROM moderation_items
          WHERE type = 'new_seed' AND status IN ('new', 'under_review')) AS new_seeds
    `),
  ]);
  const r = now.rows[0];
  return {
    events: Object.fromEntries(events.rows.map((e) => [e.kind, e.n])),
    accounts: r.accounts,
    monthly: r.monthly,
    annual: r.annual,
    lifetime: r.lifetime,
    corrections: r.corrections,
    newSeeds: r.new_seeds,
  };
}

function plural(n: number, one: string, many: string = one + 's'): string {
  return `${n} ${n === 1 ? one : many}`;
}

function buildLines(c: Counts): OwnerAlertLine[] {
  const e = (kind: OwnerEventKind): number => c.events[kind] ?? 0;
  const users = { label: 'Open users', path: '/admin/users' };
  const lines: OwnerAlertLine[] = [];

  if (e('account_created') > 0) {
    lines.push({ text: `Accounts: ${e('account_created')} new. ${c.accounts} total.`, link: users });
  }
  if (e('deletion_scheduled') > 0 || e('deletion_cancelled') > 0) {
    lines.push({
      text: `Deletions: ${e('deletion_scheduled')} scheduled, ${e('deletion_cancelled')} cancelled.`,
      link: users,
    });
  }
  if (e('subscription_started') > 0 || e('lifetime_purchased') > 0 || e('subscription_cancelled') > 0) {
    lines.push({
      text:
        `Supporters: ${e('subscription_started')} new, ${e('lifetime_purchased')} lifetime, ` +
        `${e('subscription_cancelled')} cancelled. ` +
        `Now ${c.monthly} monthly, ${c.annual} yearly, ${c.lifetime} lifetime.`,
      link: users,
    });
  }
  if (e('refund') > 0 || e('dispute') > 0) {
    lines.push({
      text: `Refunds and disputes: ${plural(e('refund'), 'refund')}, ${plural(e('dispute'), 'dispute')}.`,
      link: users,
    });
  }
  if (e('beta_terms_accepted') > 0) {
    lines.push({
      text: `Beta terms accepted: ${e('beta_terms_accepted')}.`,
      link: { label: 'Open beta', path: '/admin/beta' },
    });
  }
  if (e('takeover') > 0 || e('not_me') > 0) {
    lines.push({ text: `Takeovers: ${e('takeover')}. Not-me reports: ${e('not_me')}.`, link: users });
  }
  if (c.corrections > 0 || c.newSeeds > 0) {
    lines.push({
      text:
        `Waiting for review: ${plural(c.corrections, 'correction')}, ` +
        `${plural(c.newSeeds, 'new seed')}.`,
      link: { label: 'Open moderation', path: '/admin/moderation' },
    });
  }
  return lines;
}

export async function runOwnerDigest(now: Date = new Date()): Promise<'sent' | 'empty' | 'skipped'> {
  const today = pacificParts(now);
  if (today.hour < DIGEST_HOUR) return 'skipped';

  const { rows } = await db.query<{ last_sent_at: Date | null }>(
    'SELECT last_sent_at FROM owner_digest_state WHERE id = 1',
  );
  if (rows.length === 0) return 'skipped';
  const prev = rows[0].last_sent_at;
  if (prev && pacificParts(prev).date === today.date) return 'skipped';

  // Claim the run before counting or sending, so two processes (or two ticks)
  // can never both send. prev goes back exactly as pg returned it: the column is
  // only written from JS Dates (ms), so the value round-trips.
  const claim = await db.query(
    `UPDATE owner_digest_state SET last_sent_at = $1
      WHERE id = 1 AND last_sent_at IS NOT DISTINCT FROM $2`,
    [now, prev],
  );
  if (claim.rowCount === 0) return 'skipped';

  const start = prev ?? new Date(now.getTime() - DAY_MS);
  // An event committed while this run is counting can fall between two windows. Rare, accepted.
  const lines = buildLines(await loadCounts(start, now));
  if (lines.length === 0) return 'empty';

  // A failed send leaves the marker moved: a missed digest is acceptable, a
  // duplicate is not. sendOwnerAlert never throws.
  await sendOwnerAlert({
    kind: 'owner_digest',
    subject: 'Daily summary for ' + subjectDateFmt.format(now),
    lines,
  });
  return 'sent';
}

export function startOwnerDigestCron(): void {
  const tick = (): void => {
    runOwnerDigest().catch((err: unknown) => logger.error('[owner-digest] failed', err));
  };
  tick();
  cron.schedule('5 * * * *', tick, { timezone: 'America/Los_Angeles' });
}

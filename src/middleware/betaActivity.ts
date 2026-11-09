import { Request, Response, NextFunction } from 'express';
import { db } from '../lib/db';
import { logger } from '../lib/logger';
import { getServerConfig } from '../lib/serverConfig';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// A saved change under any of these (the path itself or below it) counts
// toward a participant's active weeks.
const COUNTED_PREFIXES = [
  '/api/gardens',
  '/api/plantings',
  '/api/soil-readings',
  '/api/amendments',
  '/api/seeds',
  '/api/harvests',
];
const COUNTED_EXACT = new Set(['/api/planting-guide/done', '/api/planting-guide/overrides']);

// Writes the client makes on its own (a canvas snapshot, catching the shown
// stage up to the nightly one) or that ask for review rather than change the
// garden. <id> is one non-slash segment.
const EXCLUDED: ReadonlyArray<readonly [string, RegExp]> = [
  ['POST', /^\/api\/gardens\/[^/]+\/thumbnail$/],
  ['PATCH', /^\/api\/gardens\/[^/]+\/plantings\/displayed-stage$/],
  ['POST', /^\/api\/seeds\/[^/]+\/contribute$/],
];

// method is upper case; path is normalised as in pendingDeletion.ts.
export function isCountedWrite(method: string, path: string): boolean {
  if (!WRITE_METHODS.has(method)) return false;
  const counted =
    COUNTED_EXACT.has(path) || COUNTED_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
  if (!counted) return false;
  return !EXCLUDED.some(([m, re]) => m === method && re.test(path));
}

const PACIFIC_DAY = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  weekday: 'short',
});
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// The Monday (YYYY-MM-DD) of the America/Los_Angeles week holding `at`, the same
// day Postgres gives for date_trunc('week', at AT TIME ZONE 'America/Los_Angeles').
export function pacificWeekStart(at: Date): string {
  const parts = Object.fromEntries(PACIFIC_DAY.formatToParts(at).map((p) => [p.type, p.value]));
  const sinceMonday = WEEKDAYS.indexOf(parts.weekday);
  // Calendar arithmetic on the Pacific date alone, so DST never shifts the day.
  const day = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
  day.setUTCDate(day.getUTCDate() - sinceMonday);
  return day.toISOString().slice(0, 10);
}

// Process-local: `${accountId}:${weekStart}` already written, so a busy week
// costs one insert per account per process. Added only after the insert
// succeeds; a failed one is tried again on the next write. It is never pruned:
// it grows by participants x weeks, which is bounded because the beta has a
// fixed length, so that growth is deliberate.
const recorded = new Set<string>();
const pending = new Set<Promise<void>>();
let clock: () => Date = () => new Date();

async function recordWeek(accountId: number, at: Date): Promise<void> {
  if (at.getTime() >= getServerConfig().betaEndsAt.getTime()) return;
  const weekStart = pacificWeekStart(at);
  const key = `${accountId}:${weekStart}`;
  if (recorded.has(key)) return;
  await db.query(
    `INSERT INTO beta_active_weeks (account_id, week_start, first_active_at)
     VALUES ($1, $2::date, $3)
     ON CONFLICT DO NOTHING`,
    [accountId, weekStart, at],
  );
  recorded.add(key);
}

// Records the Pacific week of each saved change a beta participant makes, for
// the lifetime-tier count. Runs after the response is sent and never fails or
// delays the request. betaParticipant comes from findSession on every request.
export function trackBetaActivity(req: Request, res: Response, next: NextFunction): void {
  const account = req.session?.account;
  if (!WRITE_METHODS.has(req.method) || account?.betaParticipant !== true) return next();

  const path = req.originalUrl.split('?')[0].replace(/\/+$/, '').toLowerCase();
  if (!isCountedWrite(req.method, path)) return next();

  const accountId = account.id;
  res.on('finish', () => {
    if (res.statusCode < 200 || res.statusCode >= 300) return;
    let write: Promise<void>;
    try {
      write = recordWeek(accountId, clock()).catch((err: unknown) => {
        logger.error('Recording a beta active week failed', err, { accountId });
      });
    } catch (err) {
      logger.error('Recording a beta active week failed', err, { accountId });
      return;
    }
    pending.add(write);
    void write.finally(() => pending.delete(write));
  });
  next();
}

// ── Test hooks ────────────────────────────────────────────────────────────────

export function setBetaActivityClockForTests(now: (() => Date) | null): void {
  clock = now ?? (() => new Date());
}

export function resetBetaActivityForTests(): void {
  recorded.clear();
}

// Resolves once every insert started so far has finished.
export async function betaActivitySettledForTests(): Promise<void> {
  await Promise.all([...pending]);
}

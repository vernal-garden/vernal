// Nightly sowing reminders (Phase 76). Tells a garden's owner when a sowing
// window opens, or is about to close, for a seed planted in the garden. Each
// reminder is recorded in sowing_reminders_sent, so it goes out once.

import type { PoolClient } from 'pg';
import { jobDb as db } from './db'; // long-running work: job pool
import { logger } from './logger';
import { getServerConfig } from './serverConfig';
import { resolveFrostContext } from './frostDates';
import { storedFrostStation } from './frostStations';
import { addDays, computeWindows, type Overrides, type Window } from './plantingSchedule';
import { currentSeason, nextSeason, todayPacific } from './season';
import { seedKeyString, type SeedKey } from './sowingSync';

type WindowKind = 'indoor_start' | 'transplant' | 'direct_sow';
type OpenGroup = 'indoor_start' | 'transplant' | 'transplant_sown' | 'direct_sow';

const WINDOW_KINDS: Array<[WindowKind, 'indoorStart' | 'transplant' | 'directSow']> = [
  ['indoor_start', 'indoorStart'],
  ['transplant', 'transplant'],
  ['direct_sow', 'directSow'],
];

const OPEN_GROUPS: OpenGroup[] = ['indoor_start', 'transplant', 'transplant_sown', 'direct_sow'];

const NO_OVERRIDES: Overrides = { indoorStart: null, transplant: null, directSow: null };

interface GardenRow {
  id: number;
  name: string;
  owner_id: number;
  zone: string;
  zone_location_label: string | null;
  frost_station_id: string | null;
  frost_station_label: string | null;
  last: string | null;
  first: string | null;
}

interface SeedRow {
  season: number;
  seed_id: string | null;
  cambium_seed_id: string | null;
  common_name: string;
  weeks_to_transplant: number | null;
  frost_tolerance: string | null;
  maturity_days_min: number | null;
  maturity_days_max: number | null;
  has_planned: boolean;
  earliest_sown: string | null;
}

interface Candidate {
  seedKey: string;
  windowKind: WindowKind;
  reminder: 'open' | 'closing';
  name: string;
  group: OpenGroup | null; // open reminders only
  endsOn: string;
}

export interface SowingReminderPayload {
  gardenId: number;
  gardenName: string;
  season: number;
  open?: Partial<Record<OpenGroup, string[]>>;
  closing?: Array<{ name: string; windowKind: WindowKind; endsOn: string }>;
}

function keyOf(row: { seed_id: string | null; cambium_seed_id: string | null }): string {
  const key: SeedKey = row.seed_id !== null
    ? { kind: 'seed', id: Number(row.seed_id) }
    : { kind: 'cambium', id: Number(row.cambium_seed_id) };
  return seedKeyString(key);
}

// The reminders due for one seed's window today. Dates are YYYY-MM-DD, so
// string comparison is date comparison.
function dueReminders(
  row: SeedRow,
  seedKey: string,
  windowKind: WindowKind,
  w: NonNullable<Window>,
  today: string,
  tomorrow: string,
): Candidate[] {
  if (today > w.end) return [];
  // Nothing is due before the window opens. A custom date is a one-day
  // window, so without this its closing reminder would go out a week before
  // its open one.
  if (w.start > tomorrow) return [];
  const out: Candidate[] = [];
  const base = { seedKey, windowKind, name: row.common_name, endsOn: w.end };

  let group: OpenGroup | null = null;
  if (row.has_planned) group = windowKind;
  // A seed sown outdoors before the transplant window is ready to move.
  else if (windowKind === 'transplant' && row.earliest_sown !== null && row.earliest_sown < w.start) {
    group = 'transplant_sown';
  }
  if (group !== null) out.push({ ...base, reminder: 'open', group });

  // The closing reminder also needs the window open (checked above).
  if (addDays(w.end, -7) <= tomorrow && row.has_planned) {
    out.push({ ...base, reminder: 'closing', group: null });
  }
  return out;
}

function buildPayload(garden: GardenRow, season: number, sent: Candidate[]): SowingReminderPayload {
  const payload: SowingReminderPayload = { gardenId: garden.id, gardenName: garden.name, season };

  const open: Partial<Record<OpenGroup, string[]>> = {};
  for (const group of OPEN_GROUPS) {
    const names = sent
      .filter((c) => c.reminder === 'open' && c.group === group)
      .map((c) => c.name)
      .sort((a, b) => a.localeCompare(b));
    if (names.length > 0) open[group] = names;
  }
  if (Object.keys(open).length > 0) payload.open = open;

  const closing = sent
    .filter((c) => c.reminder === 'closing')
    .map((c) => ({ name: c.name, windowKind: c.windowKind, endsOn: c.endsOn }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.windowKind.localeCompare(b.windowKind));
  if (closing.length > 0) payload.closing = closing;

  return payload;
}

// Every reminder due today for one garden, by season. Uses the stored frost
// context only; the station lookup is left to the Guide.
async function gardenCandidates(
  garden: GardenRow,
  seasons: number[],
  today: string,
  tomorrow: string,
): Promise<Map<number, Candidate[]>> {
  // Same seed columns as the Planting Guide query.
  const { rows } = await db.query<SeedRow>(
    `SELECT p.season, p.seed_id::text,
            (CASE WHEN p.seed_id IS NULL THEN p.cambium_seed_id END)::text AS cambium_seed_id,
            CASE WHEN p.seed_id IS NOT NULL THEN s.common_name ELSE cs.common_name END AS common_name,
            CASE WHEN p.seed_id IS NOT NULL THEN s.weeks_to_transplant ELSE cs.weeks_to_transplant END AS weeks_to_transplant,
            CASE WHEN p.seed_id IS NOT NULL THEN s.frost_tolerance ELSE cs.frost_tolerance END AS frost_tolerance,
            CASE WHEN p.seed_id IS NOT NULL THEN s.maturity_days_min ELSE cs.maturity_days_min END AS maturity_days_min,
            CASE WHEN p.seed_id IS NOT NULL THEN s.maturity_days_max ELSE cs.maturity_days_max END AS maturity_days_max,
            bool_or(p.state = 'planned') AS has_planned,
            to_char(MIN(p.planting_date) FILTER (
              WHERE p.state = 'growing' AND p.start_method = 'sown'), 'YYYY-MM-DD') AS earliest_sown
     FROM plantings p
     LEFT JOIN seeds s          ON s.id  = p.seed_id
     LEFT JOIN cambium.seeds cs ON cs.id = p.cambium_seed_id AND p.seed_id IS NULL
     WHERE p.garden_id = $1 AND p.season = ANY($2::int[])
     -- One row per seed key: a personal seed's plantings group together
     -- whatever Cambium seed each one also links.
     GROUP BY p.season, p.seed_id, CASE WHEN p.seed_id IS NULL THEN p.cambium_seed_id END, s.id, cs.id
     ORDER BY p.season, p.seed_id, cambium_seed_id`,
    [garden.id, seasons],
  );
  const result = new Map<number, Candidate[]>(seasons.map((s) => [s, []]));
  if (rows.length === 0) return result;

  // The owner's dates for this garden; the first row wins, as in the Guide.
  const { rows: prefRows } = await db.query<{
    seed_id: string | null;
    cambium_seed_id: string | null;
    indoor_start: string | null;
    transplant: string | null;
    direct_sow: string | null;
  }>(
    `SELECT seed_id::text, cambium_seed_id::text,
            to_char(custom_indoor_start_date, 'YYYY-MM-DD') AS indoor_start,
            to_char(custom_transplant_date,   'YYYY-MM-DD') AS transplant,
            to_char(custom_direct_sow_date,   'YYYY-MM-DD') AS direct_sow
     FROM user_seed_preferences
     WHERE account_id = $1 AND garden_id = $2
     ORDER BY id`,
    [garden.owner_id, garden.id],
  );
  const preferences = new Map<string, Overrides>();
  for (const p of prefRows) {
    const key = keyOf(p);
    if (!preferences.has(key)) {
      preferences.set(key, { indoorStart: p.indoor_start, transplant: p.transplant, directSow: p.direct_sow });
    }
  }

  const accountFrost = garden.last ? { last: garden.last, first: garden.first } : null;
  const station = storedFrostStation(garden);
  const frostBySeason = new Map(
    seasons.map((s) => [s, resolveFrostContext(accountFrost, garden.zone, s, station)]),
  );

  for (const row of rows) {
    const seedKey = keyOf(row);
    const windows = computeWindows(
      {
        weeksToTransplant: row.weeks_to_transplant,
        frostTolerance: row.frost_tolerance,
        maturityDaysMin: row.maturity_days_min,
        maturityDaysMax: row.maturity_days_max,
      },
      preferences.get(seedKey) ?? NO_OVERRIDES,
      frostBySeason.get(row.season)!,
      row.season,
    );
    for (const [windowKind, field] of WINDOW_KINDS) {
      const w = windows[field];
      if (w === null) continue;
      result.get(row.season)!.push(...dueReminders(row, seedKey, windowKind, w, today, tomorrow));
    }
  }
  return result;
}

// Sends at most one 'sowing_reminder' notification per account garden.
// Seasons are tried current first; once one sends, the next season's rows are
// left unrecorded so they go out on a later night (the payload names a single
// season). The rows are inserted with ON CONFLICT DO NOTHING and the payload
// is built from only the rows inserted, in the same transaction as the
// notification, so a repeat or concurrent run never sends a reminder twice.
// Does nothing unless SOWING_REMINDERS_ENABLED is on (read at call time).
// Accounts scheduled for deletion are skipped.
export async function runSowingReminders(
  now: Date = new Date(),
): Promise<{ affected: number; failed: number }> {
  if (!getServerConfig().sowingReminders) return { affected: 0, failed: 0 };
  const seasons = [currentSeason(now), nextSeason(now)];
  const today = todayPacific(now);
  const tomorrow = addDays(today, 1);

  const { rows: gardens } = await db.query<GardenRow>(
    `SELECT g.id, g.name, g.owner_id, g.zone, g.zone_location_label,
            g.frost_station_id, g.frost_station_label,
            to_char(a.last_spring_frost_date, 'YYYY-MM-DD') AS last,
            to_char(a.first_fall_frost_date,  'YYYY-MM-DD') AS first
     FROM gardens g
     JOIN accounts a ON a.id = g.owner_id
     WHERE a.deletion_scheduled_at IS NULL
       AND EXISTS (SELECT 1 FROM plantings p WHERE p.garden_id = g.id AND p.season = ANY($1::int[]))
     ORDER BY g.id`,
    [seasons],
  );

  let affected = 0;
  let failed = 0;
  for (const garden of gardens) {
    let client: PoolClient | null = null;
    let releaseErr: Error | undefined;
    try {
      const candidates = await gardenCandidates(garden, seasons, today, tomorrow);
      if (seasons.every((s) => candidates.get(s)!.length === 0)) continue;
      client = await db.connect();
      await client.query('BEGIN');
      for (const season of seasons) {
        const due = candidates.get(season)!;
        if (due.length === 0) continue;
        const { rows: inserted } = await client.query<{
          seed_key: string;
          window_kind: WindowKind;
          reminder: 'open' | 'closing';
        }>(
          `INSERT INTO sowing_reminders_sent (garden_id, seed_key, season, window_kind, reminder)
           SELECT $1, t.seed_key, $2, t.window_kind, t.reminder
           FROM unnest($3::text[], $4::text[], $5::text[]) AS t(seed_key, window_kind, reminder)
           ON CONFLICT DO NOTHING
           RETURNING seed_key, window_kind, reminder`,
          [
            garden.id,
            season,
            due.map((c) => c.seedKey),
            due.map((c) => c.windowKind),
            due.map((c) => c.reminder),
          ],
        );
        if (inserted.length === 0) continue;
        const sentKeys = new Set(inserted.map((r) => `${r.seed_key}|${r.window_kind}|${r.reminder}`));
        const sent = due.filter((c) => sentKeys.has(`${c.seedKey}|${c.windowKind}|${c.reminder}`));
        await client.query(
          `INSERT INTO notifications (account_id, type, payload) VALUES ($1, 'sowing_reminder', $2)`,
          [garden.owner_id, JSON.stringify(buildPayload(garden, season, sent))],
        );
        affected += 1;
        break;
      }
      await client.query('COMMIT');
    } catch (err) {
      // One bad garden must not stop the others; it is retried tomorrow.
      // A failed ROLLBACK means a broken connection: drop it from the pool.
      await client?.query('ROLLBACK').catch((e: unknown) => {
        releaseErr = e instanceof Error ? e : new Error(String(e));
      });
      logger.error('Could not send sowing reminders for garden', err, { gardenId: garden.id });
      failed += 1;
    } finally {
      client?.release(releaseErr);
    }
  }
  return { affected, failed };
}

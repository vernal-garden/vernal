import { Router, Request, Response } from 'express';
import { db } from '../lib/db';
import { requireAuth, requireSupporter } from '../middleware/auth';
import { isNumericId } from '../lib/validation';
import { resolveFrostContext } from '../lib/frostDates';
import { computeWindows, currentSeason, type Overrides } from '../lib/plantingSchedule';
import { bedAreaSqFt, type BedAreaInput } from '../lib/bedArea';
import * as metricsCache from '../lib/metricsCache';
import {
  PH_BALANCED_MAX,
  PH_BALANCED_MIN,
  TIMING_TOLERANCE_DAYS,
  TREND_SAME_PCT,
  WEATHER_TIMEOUT_MS,
} from '../lib/metricsConstants';
import { logger } from '../lib/logger';
import { getAccountLocation } from '../lib/weather/location';
import {
  buildInsights,
  weekSummary,
  type WeatherInsight,
  type WeekSummary,
} from '../lib/weather/insights';
import { geocode, fetchOpenMeteoHistory } from '../lib/weather/providers/openMeteo';
import type { SessionData } from '../types';

// Metrics Dashboard and Cross-Season Comparison (Phase 49). Read-only: every
// aggregate is computed here and the client renders what it gets. Units are
// never converted — a plant's numbers are always in its dominant unit.

const router = Router();
router.use(requireAuth);

// ── Constants ─────────────────────────────────────────────────────────────────

// Mirrors harvests.ts: harvested_at is noon Pacific on the harvest date.
const TZ = 'America/Los_Angeles';
const LOCAL_DATE = `(h.harvested_at AT TIME ZONE '${TZ}')::date`;
const SEASON_OF_ENTRY = `EXTRACT(YEAR FROM ${LOCAL_DATE})::int`;

const RECENT_LIMIT = 5;
const TREND_LIMIT = 3;
const MAX_COMPARE_SEASONS = 4;
const NOTES_EXCERPT_LENGTH = 80;

const DAY_MS = 24 * 60 * 60 * 1000;

// Largest Postgres INTEGER; a bigger id would make the query itself fail.
const MAX_INT_ID = 2147483647;

const NO_OVERRIDES: Overrides = { indoorStart: null, transplant: null, directSow: null };

// ── SQL fragments ─────────────────────────────────────────────────────────────

const COMMON_NAME = 'CASE WHEN h.seed_id IS NOT NULL THEN s.common_name ELSE cs.common_name END';
const SCIENTIFIC_NAME =
  'CASE WHEN h.seed_id IS NOT NULL THEN s.scientific_name ELSE cs.scientific_name END';

// A plant is keyed by its personal seed when it has one, otherwise by its
// Cambium seed. cambium_seed_id is only reported when it is the key.
const ENTRY_PLANT_COLUMNS = `
  h.seed_id::text AS seed_id,
  CASE WHEN h.seed_id IS NULL THEN h.cambium_seed_id::text END AS cambium_seed_id,
  ${COMMON_NAME} AS common_name`;

// $1 = account id. Only entries in gardens the account owns.
const ENTRY_FROM = `
  FROM harvest_entries h
  JOIN gardens g ON g.id = h.garden_id
  LEFT JOIN beds b ON b.id = h.bed_id
  LEFT JOIN seeds s ON s.id = h.seed_id
  LEFT JOIN cambium.seeds cs ON cs.id = h.cambium_seed_id
  WHERE g.owner_id = $1`;

// ── Types ─────────────────────────────────────────────────────────────────────

type SeedKey = { kind: 'seed'; id: number } | { kind: 'cambium'; id: number };

interface GardenRow {
  id: string;
  name: string;
  zone: string;
}

interface EntryRow {
  id: string;
  garden_id: string;
  bed_id: string | null;
  seed_id: string | null;
  cambium_seed_id: string | null;
  common_name: string | null;
  sowing_event_id: string | null;
  harvest_date: string;
  quantity: string | null;
  unit: string | null;
}

interface PlantTotal {
  key: string;
  seedId: string | null;
  cambiumSeedId: string | null;
  commonName: string | null;
  total: number | null;
  unit: string | null;
  mixedUnits: boolean;
  entryCount: number;
}

interface SowingCandidateRow {
  id: string;
  garden_id: string;
  seed_id: string | null;
  cambium_seed_id: string | null;
  common_name: string | null;
  planting_date: string | null;
  done_date: string;
  weeks_to_transplant: number | null;
  frost_tolerance: string | null;
  maturity_days_min: number | null;
  maturity_days_max: number | null;
}

type TimingStatus = 'early' | 'on_time' | 'late';

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseSeason(v: unknown): number | null {
  const n = typeof v === 'string' && /^\d+$/.test(v) ? parseInt(v, 10) : v;
  if (!Number.isInteger(n) || (n as number) < 2000 || (n as number) > 2100) return null;
  return n as number;
}

function parsePlantKey(v: unknown): SeedKey | null {
  const m = typeof v === 'string' ? /^(seed|cambium):(\d+)$/.exec(v) : null;
  if (!m) return null;
  const id = parseInt(m[2], 10);
  return id > 0 && id <= MAX_INT_ID ? { kind: m[1] as SeedKey['kind'], id } : null;
}

// A numeric id string that fits a Postgres INTEGER, normalized ('007' → '7').
function parseIntId(v: unknown): string | null {
  if (!isNumericId(v)) return null;
  const n = parseInt(v, 10);
  return n > 0 && n <= MAX_INT_ID ? String(n) : null;
}

// SQL predicate matching a SeedKey against seed_id / cambium_seed_id columns.
function seedKeyWhere(key: SeedKey, param: string, alias = ''): string {
  return key.kind === 'seed'
    ? `${alias}seed_id = ${param}`
    : `${alias}seed_id IS NULL AND ${alias}cambium_seed_id = ${param}`;
}

// Null for an entry whose personal seed was deleted (both ids nulled): it still
// counts as a harvest, but can't be grouped or linked as a plant.
function plantKeyOf(r: { seed_id: string | null; cambium_seed_id: string | null }): string | null {
  if (r.seed_id !== null) return `seed:${r.seed_id}`;
  if (r.cambium_seed_id !== null) return `cambium:${r.cambium_seed_id}`;
  return null;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function byName(a: string | null, b: string | null): number {
  return (a ?? '').localeCompare(b ?? '');
}

// Half away from zero, so +12.5 and -12.5 round to the same magnitude.
function round(n: number, decimals = 0): number {
  const f = 10 ** decimals;
  return (Math.sign(n) * Math.round(Math.abs(n) * f)) / f;
}

// Strips float noise from summed NUMERIC quantities (0.1 + 0.2) without
// rounding away any precision a gardener would actually enter.
function cleanSum(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function dayNumber(date: string): number {
  return Date.parse(`${date}T00:00:00Z`) / DAY_MS;
}

function daysBetween(from: string, to: string): number {
  return Math.round(dayNumber(to) - dayNumber(from));
}

function avgDaysBetween(dates: string[]): number | null {
  if (dates.length < 2) return null;
  const sorted = [...dates].sort();
  return round(daysBetween(sorted[0], sorted[sorted.length - 1]) / (dates.length - 1), 1);
}

// The unit on the most entries with a quantity; ties go alphabetically.
function dominantUnit(entries: { quantity: string | null; unit: string | null }[]): string | null {
  const counts = new Map<string, number>();
  for (const e of entries) {
    if (e.quantity === null || e.unit === null) continue;
    counts.set(e.unit, (counts.get(e.unit) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const [unit, count] of counts) {
    const bestCount = best === null ? -1 : counts.get(best)!;
    if (count > bestCount || (count === bestCount && cmp(unit, best!) < 0)) best = unit;
  }
  return best;
}

// Sum of the quantities recorded in `unit`, and whether any other unit appears.
function sumInUnit(
  entries: { quantity: string | null; unit: string | null }[],
  unit: string | null,
): { total: number | null; mixedUnits: boolean } {
  let total: number | null = null;
  let mixedUnits = false;
  for (const e of entries) {
    if (e.quantity === null || e.unit === null) continue;
    if (e.unit === unit) total = (total ?? 0) + Number(e.quantity);
    else mixedUnits = true;
  }
  return { total: total === null ? null : cleanSum(total), mixedUnits };
}

function notesExcerpt(notes: string | null): string | null {
  if (notes === null) return null;
  // Spread by code point so an emoji is never cut in half.
  return [...notes].slice(0, NOTES_EXCERPT_LENGTH).join('');
}

// ── Totals ────────────────────────────────────────────────────────────────────

// Per-plant totals in each plant's dominant unit, ordered for display: plants
// grouped by unit (the unit most plants use first, then by unit name), largest
// total first within a group, and plants with no quantities last by entry count.
function computeTotals(entries: EntryRow[]): PlantTotal[] {
  const byPlant = new Map<string, EntryRow[]>();
  for (const e of entries) {
    const key = plantKeyOf(e);
    if (key === null) continue;
    const list = byPlant.get(key);
    if (list) list.push(e);
    else byPlant.set(key, [e]);
  }

  const totals: PlantTotal[] = [];
  for (const [key, list] of byPlant) {
    const unit = dominantUnit(list);
    const { total, mixedUnits } = sumInUnit(list, unit);
    totals.push({
      key,
      seedId: list[0].seed_id,
      cambiumSeedId: list[0].cambium_seed_id,
      commonName: list[0].common_name,
      total,
      unit,
      mixedUnits,
      entryCount: list.length,
    });
  }

  const plantsPerUnit = new Map<string, number>();
  for (const t of totals) {
    if (t.unit !== null) plantsPerUnit.set(t.unit, (plantsPerUnit.get(t.unit) ?? 0) + 1);
  }

  return totals.sort((a, b) => {
    if (a.unit === null || b.unit === null) {
      if (a.unit !== b.unit) return a.unit === null ? 1 : -1;
      return b.entryCount - a.entryCount || byName(a.commonName, b.commonName) || cmp(a.key, b.key);
    }
    if (a.unit !== b.unit) {
      return plantsPerUnit.get(b.unit)! - plantsPerUnit.get(a.unit)! || cmp(a.unit, b.unit);
    }
    return b.total! - a.total! || byName(a.commonName, b.commonName) || cmp(a.key, b.key);
  });
}

function formatTotal(t: PlantTotal) {
  return {
    seedId: t.seedId,
    cambiumSeedId: t.cambiumSeedId,
    commonName: t.commonName,
    total: t.total,
    unit: t.unit,
    mixedUnits: t.mixedUnits,
    entryCount: t.entryCount,
  };
}

// ── Data loaders ──────────────────────────────────────────────────────────────

async function loadGardens(accountId: number): Promise<GardenRow[]> {
  const { rows } = await db.query<GardenRow>(
    'SELECT id::text, name, zone FROM gardens WHERE owner_id = $1 ORDER BY id',
    [accountId],
  );
  return rows;
}

// Every entry in the account's gardens for one season, oldest first.
async function loadSeasonEntries(accountId: number, season: number): Promise<EntryRow[]> {
  const { rows } = await db.query<EntryRow>(
    `SELECT h.id::text, h.garden_id::text, h.bed_id::text, ${ENTRY_PLANT_COLUMNS},
            h.sowing_event_id::text AS sowing_event_id,
            to_char(${LOCAL_DATE}, 'YYYY-MM-DD') AS harvest_date,
            h.quantity::text, h.unit
     ${ENTRY_FROM} AND ${SEASON_OF_ENTRY} = $2
     ORDER BY h.harvested_at, h.id`,
    [accountId, season],
  );
  return rows;
}

// Same query and behavior as GET /api/planting-guide.
async function loadAccountFrost(
  accountId: number,
): Promise<{ last: string; first: string | null } | null> {
  const { rows } = await db.query<{ last: string | null; first: string | null }>(
    `SELECT to_char(last_spring_frost_date, 'YYYY-MM-DD') AS last,
            to_char(first_fall_frost_date,  'YYYY-MM-DD') AS first
     FROM accounts WHERE id = $1`,
    [accountId],
  );
  return rows[0]?.last ? { last: rows[0].last, first: rows[0].first } : null;
}

// The account's date overrides keyed `${gardenId}:${plantKey}`; the first row
// by id wins, as in the planting guide.
async function loadOverrides(accountId: number, gardenIds: number[]): Promise<Map<string, Overrides>> {
  const { rows } = await db.query<{
    garden_id: string;
    seed_id: string | null;
    cambium_seed_id: string | null;
    indoor_start: string | null;
    transplant: string | null;
    direct_sow: string | null;
  }>(
    `SELECT garden_id::text, seed_id::text, cambium_seed_id::text,
            to_char(custom_indoor_start_date, 'YYYY-MM-DD') AS indoor_start,
            to_char(custom_transplant_date,   'YYYY-MM-DD') AS transplant,
            to_char(custom_direct_sow_date,   'YYYY-MM-DD') AS direct_sow
     FROM user_seed_preferences
     WHERE account_id = $1 AND garden_id = ANY($2::int[])
     ORDER BY id`,
    [accountId, gardenIds],
  );
  const overrides = new Map<string, Overrides>();
  for (const p of rows) {
    const key = `${p.garden_id}:${plantKeyOf(p)}`;
    if (!overrides.has(key)) {
      overrides.set(key, {
        indoorStart: p.indoor_start,
        transplant: p.transplant,
        directSow: p.direct_sow,
      });
    }
  }
  return overrides;
}

// Timing candidates for a season: one done sowing event per garden and plant
// that at least one harvest entry links to — the lowest id, which is the event
// the planting guide shows as done. Optionally limited to one plant.
async function loadSowingCandidates(
  accountId: number,
  season: number,
  plant: SeedKey | null = null,
): Promise<SowingCandidateRow[]> {
  const params: unknown[] = [accountId, season];
  let plantFilter = '';
  if (plant) {
    params.push(plant.id);
    plantFilter = ` AND ${seedKeyWhere(plant, '$3', 'se.')}`;
  }
  const plantCols = 'se.seed_id, CASE WHEN se.seed_id IS NULL THEN se.cambium_seed_id END';
  const { rows } = await db.query<SowingCandidateRow>(
    `SELECT DISTINCT ON (se.garden_id, ${plantCols})
            se.id::text, se.garden_id::text, se.seed_id::text,
            CASE WHEN se.seed_id IS NULL THEN se.cambium_seed_id::text END AS cambium_seed_id,
            CASE WHEN se.seed_id IS NOT NULL THEN s.common_name ELSE cs.common_name END AS common_name,
            to_char(p.planting_date, 'YYYY-MM-DD') AS planting_date,
            to_char((se.marked_done_at AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') AS done_date,
            CASE WHEN se.seed_id IS NOT NULL THEN s.weeks_to_transplant ELSE cs.weeks_to_transplant END AS weeks_to_transplant,
            CASE WHEN se.seed_id IS NOT NULL THEN s.frost_tolerance ELSE cs.frost_tolerance END AS frost_tolerance,
            CASE WHEN se.seed_id IS NOT NULL THEN s.maturity_days_min ELSE cs.maturity_days_min END AS maturity_days_min,
            CASE WHEN se.seed_id IS NOT NULL THEN s.maturity_days_max ELSE cs.maturity_days_max END AS maturity_days_max
     FROM sowing_events se
     JOIN gardens g ON g.id = se.garden_id
     LEFT JOIN plantings p ON p.id = se.planting_id
     LEFT JOIN seeds s ON s.id = se.seed_id
     LEFT JOIN cambium.seeds cs ON cs.id = se.cambium_seed_id
     WHERE g.owner_id = $1 AND se.season = $2 AND se.marked_done_at IS NOT NULL
       AND EXISTS (SELECT 1 FROM harvest_entries h WHERE h.sowing_event_id = se.id)${plantFilter}
     ORDER BY se.garden_id, ${plantCols}, se.id`,
    params,
  );
  return rows;
}

// planting_date when the event's planting has one, else the day it was marked done.
function sowDateOf(c: SowingCandidateRow): {
  sowDate: string;
  sowDateSource: 'planting' | 'marked_done';
} {
  return c.planting_date !== null
    ? { sowDate: c.planting_date, sowDateSource: 'planting' }
    : { sowDate: c.done_date, sowDateSource: 'marked_done' };
}

// First harvest date per sowing event id among the given entries; entries not
// linked to a sowing event are skipped.
function firstHarvestBySowingEvent(
  entries: { sowing_event_id: string | null; harvest_date: string }[],
): Map<string, string> {
  const first = new Map<string, string>();
  for (const e of entries) {
    if (e.sowing_event_id === null) continue;
    const prev = first.get(e.sowing_event_id);
    if (prev === undefined || e.harvest_date < prev) first.set(e.sowing_event_id, e.harvest_date);
  }
  return first;
}

// ── Timing ────────────────────────────────────────────────────────────────────

// Status of a sow date against a window widened by TIMING_TOLERANCE_DAYS on
// each side (edges count as on time). weeks is how far outside, at least 1.
function timingStatus(
  sowDate: string,
  start: string,
  end: string,
): { status: TimingStatus; weeks: number } {
  const sow = dayNumber(sowDate);
  const lo = dayNumber(start) - TIMING_TOLERANCE_DAYS;
  const hi = dayNumber(end) + TIMING_TOLERANCE_DAYS;
  if (sow >= lo && sow <= hi) return { status: 'on_time', weeks: 0 };
  const daysOutside = sow < lo ? lo - sow : sow - hi;
  return {
    status: sow < lo ? 'early' : 'late',
    weeks: Math.max(1, Math.round(daysOutside / 7)),
  };
}

interface TimingRow {
  seedId: string | null;
  cambiumSeedId: string | null;
  gardenId: string;
  commonName: string | null;
  sowDate: string;
  sowDateSource: 'planting' | 'marked_done';
  window: { name: 'indoorStart' | 'directSow'; start: string; end: string };
  status: TimingStatus;
  weeks: number;
  // Internal: used for daysToHarvest, stripped from the response.
  plantKey: string;
  sowingEventId: string;
  maturityDaysMin: number | null;
  maturityDaysMax: number | null;
}

async function buildTiming(
  accountId: number,
  season: number,
  gardens: GardenRow[],
): Promise<TimingRow[]> {
  const candidates = await loadSowingCandidates(accountId, season);
  if (candidates.length === 0) return [];

  const accountFrost = await loadAccountFrost(accountId);
  const overrides = await loadOverrides(
    accountId,
    gardens.map((g) => Number(g.id)),
  );
  const zoneByGarden = new Map(gardens.map((g) => [g.id, g.zone]));

  const rows: TimingRow[] = [];
  for (const c of candidates) {
    const plantKey = plantKeyOf(c);
    if (plantKey === null) continue;
    const frost = resolveFrostContext(accountFrost, zoneByGarden.get(c.garden_id)!, season);
    const windows = computeWindows(
      {
        weeksToTransplant: c.weeks_to_transplant,
        frostTolerance: c.frost_tolerance,
        maturityDaysMin: c.maturity_days_min,
        maturityDaysMax: c.maturity_days_max,
      },
      overrides.get(`${c.garden_id}:${plantKey}`) ?? NO_OVERRIDES,
      frost,
      season,
    );
    const name = c.weeks_to_transplant !== null ? 'indoorStart' : 'directSow';
    const window = windows[name];
    if (window === null) continue;

    const { sowDate, sowDateSource } = sowDateOf(c);
    rows.push({
      seedId: c.seed_id,
      cambiumSeedId: c.cambium_seed_id,
      gardenId: c.garden_id,
      commonName: c.common_name,
      sowDate,
      sowDateSource,
      window: { name, start: window.start, end: window.end },
      ...timingStatus(sowDate, window.start, window.end),
      plantKey,
      sowingEventId: c.id,
      maturityDaysMin: c.maturity_days_min,
      maturityDaysMax: c.maturity_days_max,
    });
  }

  return rows.sort(
    (a, b) => byName(a.commonName, b.commonName) || Number(a.gardenId) - Number(b.gardenId),
  );
}

// ── Trend ─────────────────────────────────────────────────────────────────────

async function buildTrend(accountId: number, season: number, current: PlantTotal[]) {
  const { rows } = await db.query<{ previous: number | null; total: number }>(
    `SELECT MAX(${SEASON_OF_ENTRY}) FILTER (WHERE ${SEASON_OF_ENTRY} < $2) AS previous,
            COUNT(*)::int AS total
     FROM harvest_entries h
     JOIN gardens g ON g.id = h.garden_id
     WHERE g.owner_id = $1`,
    [accountId, season],
  );
  const { previous, total } = rows[0];
  if (previous === null) {
    return { state: total > 0 ? 'one_season' : 'hidden', comparedSeason: null, plants: [] };
  }

  const prevByKey = new Map(
    computeTotals(await loadSeasonEntries(accountId, previous)).map((t) => [t.key, t]),
  );

  const plants = [];
  for (const cur of current) {
    const prev = prevByKey.get(cur.key);
    // A zero previous total has no meaningful percentage change.
    if (!prev || cur.total === null || prev.total === null || prev.total === 0) continue;
    if (cur.unit !== prev.unit) continue;
    const changePct = round(((cur.total - prev.total) / prev.total) * 100);
    plants.push({
      seedId: cur.seedId,
      cambiumSeedId: cur.cambiumSeedId,
      commonName: cur.commonName,
      changePct,
      direction:
        Math.abs(changePct) <= TREND_SAME_PCT ? 'same' : changePct > 0 ? 'up' : 'down',
    });
  }
  plants.sort(
    (a, b) => Math.abs(b.changePct) - Math.abs(a.changePct) || byName(a.commonName, b.commonName),
  );

  return { state: 'ready', comparedSeason: previous, plants: plants.slice(0, TREND_LIMIT) };
}

// ── Paid section (supporters) ─────────────────────────────────────────────────

async function buildSoil(accountId: number, season: number) {
  const { rows } = await db.query<{
    garden_id: string;
    garden_name: string;
    bed_id: string;
    bed_label: string;
    ph: string | null;
    test_date: string;
  }>(
    `SELECT * FROM (
       SELECT DISTINCT ON (b.id)
              g.id::text AS garden_id, g.name AS garden_name,
              b.id::text AS bed_id, b.label AS bed_label,
              sr.ph::text, to_char(sr.test_date, 'YYYY-MM-DD') AS test_date
       FROM beds b
       JOIN gardens g ON g.id = b.garden_id
       JOIN soil_readings sr ON sr.bed_id = b.id
       WHERE g.owner_id = $1 AND b.season = $2
         AND EXTRACT(YEAR FROM sr.test_date)::int = $2
       ORDER BY b.id, sr.test_date DESC, sr.id DESC
     ) latest
     ORDER BY garden_id::int, bed_label, bed_id::int`,
    [accountId, season],
  );
  return rows.map((r) => {
    const ph = r.ph === null ? null : Number(r.ph);
    return {
      gardenId: r.garden_id,
      gardenName: r.garden_name,
      bedId: r.bed_id,
      bedLabel: r.bed_label,
      ph,
      testDate: r.test_date,
      status:
        ph === null
          ? 'no_ph'
          : ph >= PH_BALANCED_MIN && ph <= PH_BALANCED_MAX
            ? 'balanced'
            : 'needs_attention',
    };
  });
}

// "In the season" means application_date falls in the season's calendar year,
// in any of the account's gardens.
async function buildAmendments(accountId: number, season: number) {
  // Newest first, so the first row is the latest (ties by highest id).
  const { rows: logs } = await db.query<{
    id: string;
    garden_id: string;
    garden_name: string;
    application_date: string;
    product_name: string;
    amendment_type: string;
    amount: string | null;
    amount_unit: string | null;
  }>(
    `SELECT al.id::text, al.garden_id::text, g.name AS garden_name,
            al.application_date::text AS application_date,
            al.product_name, al.amendment_type, al.amount::text, al.amount_unit
     FROM amendment_logs al
     JOIN gardens g ON g.id = al.garden_id
     WHERE g.owner_id = $1 AND EXTRACT(YEAR FROM al.application_date)::int = $2
     ORDER BY al.application_date DESC, al.id DESC`,
    [accountId, season],
  );

  const logBeds =
    logs.length === 0
      ? []
      : (
          await db.query<{ log_id: string; bed_id: string; label: string }>(
            `SELECT alb.amendment_log_id::text AS log_id, b.id::text AS bed_id, b.label
             FROM amendment_log_beds alb
             JOIN beds b ON b.id = alb.bed_id
             JOIN gardens bg ON bg.id = b.garden_id AND bg.owner_id = $2
             WHERE alb.amendment_log_id = ANY($1::int[])
             ORDER BY b.label, b.id`,
            [logs.map((l) => Number(l.id)), accountId],
          )
        ).rows;

  const { rows: seasonBeds } = await db.query<{
    bed_id: string;
    label: string;
    garden_id: string;
    garden_name: string;
  }>(
    `SELECT b.id::text AS bed_id, b.label, g.id::text AS garden_id, g.name AS garden_name
     FROM beds b
     JOIN gardens g ON g.id = b.garden_id
     WHERE g.owner_id = $1 AND b.season = $2
     ORDER BY g.id, b.label, b.id`,
    [accountId, season],
  );

  const amendedBedIds = new Set(logBeds.map((r) => r.bed_id));

  const typeCounts = new Map<string, number>();
  for (const l of logs) typeCounts.set(l.amendment_type, (typeCounts.get(l.amendment_type) ?? 0) + 1);
  const byType = [...typeCounts]
    .map(([amendmentType, count]) => ({ amendmentType, count }))
    .sort((a, b) => b.count - a.count || cmp(a.amendmentType, b.amendmentType));

  const top = logs[0];
  const latest = top
    ? {
        gardenId: top.garden_id,
        gardenName: top.garden_name,
        applicationDate: top.application_date,
        productName: top.product_name,
        amendmentType: top.amendment_type,
        amount: top.amount === null ? null : Number(top.amount),
        amountUnit: top.amount_unit,
        beds: logBeds
          .filter((r) => r.log_id === top.id)
          .map((r) => ({ bedId: r.bed_id, label: r.label })),
      }
    : null;

  return {
    applicationCount: logs.length,
    bedCount: amendedBedIds.size,
    seasonBedCount: seasonBeds.length,
    latest,
    byType,
    unamendedBeds: seasonBeds
      .filter((b) => !amendedBedIds.has(b.bed_id))
      .map((b) => ({
        bedId: b.bed_id,
        label: b.label,
        gardenId: b.garden_id,
        gardenName: b.garden_name,
      })),
  };
}

// Rejects if `promise` hasn't settled within `ms`; the timer is always cleared.
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Never throws for a weather-provider failure: the dashboard must still load.
// The week and insights describe the last 7 days, so they are only fetched for
// the current season.
async function buildWeather(accountId: number, isCurrentSeason: boolean) {
  const { rows } = await db.query<{ provider: string; last_successful_sync: Date | null }>(
    `SELECT provider, last_successful_sync FROM weather_connections
     WHERE account_id = $1
     ORDER BY is_primary DESC, created_at DESC, id DESC
     LIMIT 1`,
    [accountId],
  );
  const row = rows[0];
  const station = row
    ? {
        provider: row.provider,
        lastSuccessfulSync: row.last_successful_sync
          ? row.last_successful_sync.toISOString()
          : null,
      }
    : null;

  const { rows: prefRows } = await db.query<{ units: string | null }>(
    `SELECT preferences->>'units' AS units FROM accounts WHERE id = $1`,
    [accountId],
  );
  const units: 'imperial' | 'metric' = prefRows[0]?.units === 'metric' ? 'metric' : 'imperial';

  const locationLabel = await getAccountLocation(accountId);

  let week: WeekSummary | null = null;
  let insights: WeatherInsight[] = [];
  let historyUnavailable = false;
  if (locationLabel !== null && isCurrentSeason) {
    try {
      const history = await withTimeout(
        (async () => {
          const { lat, lon } = await geocode(locationLabel);
          return fetchOpenMeteoHistory(lat, lon);
        })(),
        WEATHER_TIMEOUT_MS,
      );
      week = weekSummary(history);
      insights = buildInsights(history);
    } catch (err) {
      logger.error('Metrics dashboard weather history failed', err);
      historyUnavailable = true;
    }
  }

  return { station, locationLabel, units, week, insights, historyUnavailable };
}

async function loadBedAreas(bedIds: string[]): Promise<Map<string, number | null>> {
  const areas = new Map<string, number | null>();
  if (bedIds.length === 0) return areas;
  const { rows } = await db.query<BedAreaInput & { id: string }>(
    `SELECT id::text, type, grid_cols, grid_rows, freeform_points, freeform_closed
     FROM beds WHERE id = ANY($1::int[])`,
    [bedIds.map(Number)],
  );
  for (const r of rows) areas.set(r.id, bedAreaSqFt(r));
  return areas;
}

// Yield per square foot: per plant, the quantities in its dominant unit that
// came from beds with a known area, over the summed area of those beds.
async function buildYieldPerSqFt(entries: EntryRow[], totals: PlantTotal[]) {
  const bedIds = [...new Set(entries.flatMap((e) => (e.bed_id === null ? [] : [e.bed_id])))];
  const areas = await loadBedAreas(bedIds);
  const unitByKey = new Map(totals.map((t) => [t.key, t.unit]));

  const acc = new Map<string, { sum: number; beds: Set<string> }>();
  for (const e of entries) {
    const key = plantKeyOf(e);
    if (key === null || e.bed_id === null || e.quantity === null) continue;
    const unit = unitByKey.get(key);
    if (unit === null || e.unit !== unit) continue;
    const area = areas.get(e.bed_id);
    if (area == null || area <= 0) continue;
    const a = acc.get(key) ?? { sum: 0, beds: new Set<string>() };
    a.sum += Number(e.quantity);
    a.beds.add(e.bed_id);
    acc.set(key, a);
  }

  // Same order as the all-gardens totals.
  const rows = [];
  for (const t of totals) {
    const a = acc.get(t.key);
    if (!a) continue;
    const area = [...a.beds].reduce((s, id) => s + areas.get(id)!, 0);
    rows.push({
      seedId: t.seedId,
      cambiumSeedId: t.cambiumSeedId,
      commonName: t.commonName,
      perSqFt: round(a.sum / area, 2),
      unit: t.unit,
    });
  }
  return rows;
}

function buildFrequency(entries: EntryRow[], totals: PlantTotal[]) {
  const datesByKey = new Map<string, string[]>();
  for (const e of entries) {
    const key = plantKeyOf(e);
    if (key === null) continue;
    const list = datesByKey.get(key);
    if (list) list.push(e.harvest_date);
    else datesByKey.set(key, [e.harvest_date]);
  }
  return totals
    .filter((t) => t.entryCount >= 2)
    .map((t) => ({
      commonName: t.commonName,
      avgDaysBetween: avgDaysBetween(datesByKey.get(t.key)!)!,
      entryCount: t.entryCount,
    }))
    .sort((a, b) => b.entryCount - a.entryCount || byName(a.commonName, b.commonName));
}

function buildDaysToHarvest(timing: TimingRow[], entries: EntryRow[]) {
  const firstHarvest = firstHarvestBySowingEvent(entries);
  const rows = [];
  for (const t of timing) {
    const min = t.maturityDaysMin;
    const max = t.maturityDaysMax;
    if (min === null || max === null) continue;
    // Only harvests linked to this row's sowing event count.
    const first = firstHarvest.get(t.sowingEventId);
    if (first === undefined) continue;
    const actualDays = daysBetween(t.sowDate, first);
    rows.push({
      commonName: t.commonName,
      actualDays,
      predictedMin: min,
      predictedMax: max,
      status: (actualDays < min ? 'early' : actualDays > max ? 'late' : 'on_time') as TimingStatus,
    });
  }
  return rows;
}

async function buildPaid(
  accountId: number,
  season: number,
  entries: EntryRow[],
  totalsAll: PlantTotal[],
  timing: TimingRow[],
  isCurrentSeason: boolean,
) {
  const yieldPerSqFt = await buildYieldPerSqFt(entries, totalsAll);
  const first = totalsAll[0];
  return {
    soil: await buildSoil(accountId, season),
    amendments: await buildAmendments(accountId, season),
    weather: await buildWeather(accountId, isCurrentSeason),
    advanced: {
      yieldPerSqFt,
      yieldPerSqFtReason: yieldPerSqFt.length === 0 ? 'no_bed_data' : null,
      // The first row of the first unit group; a null total means no plant
      // has quantities at all.
      topPerformer:
        first && first.total !== null
          ? {
              commonName: first.commonName,
              total: first.total,
              unit: first.unit,
              entryCount: first.entryCount,
            }
          : null,
      frequency: buildFrequency(entries, totalsAll),
      daysToHarvest: buildDaysToHarvest(timing, entries),
    },
  };
}

// ── GET /api/metrics/dashboard ────────────────────────────────────────────────

router.get('/dashboard', async (req: Request, res: Response) => {
  const session = req.session as SessionData;
  const accountId = session.account!.id;
  const isSupporter = session.account!.subscriptionTier === 'supporter';
  const nowSeason = currentSeason(new Date());

  let season = nowSeason;
  if (req.query.season !== undefined) {
    const parsed = parseSeason(req.query.season);
    if (parsed === null) {
      return res.status(400).json({ error: 'season must be an integer between 2000 and 2100' });
    }
    season = parsed;
  }

  let gardenId: string | null = null;
  if (req.query.gardenId !== undefined) {
    if (!isNumericId(req.query.gardenId)) {
      return res.status(400).json({ error: 'gardenId must be numeric' });
    }
    gardenId = String(parseInt(req.query.gardenId, 10));
  }

  try {
    // Checked on every read so a cached body never outlives the garden.
    const gardens = await loadGardens(accountId);
    if (gardenId !== null && !gardens.some((g) => g.id === gardenId)) {
      return res.status(404).json({ error: 'Garden not found' });
    }

    // A tier change doesn't invalidate the cache, so a body built for the
    // other tier is treated as a miss and rebuilt.
    const cacheKey = `${accountId}:${season}:${gardenId ?? 'all'}`;
    const cached = metricsCache.get(cacheKey) as { isSupporter: boolean } | undefined;
    if (cached && cached.isSupporter === isSupporter) return res.json(cached);

    const entries = await loadSeasonEntries(accountId, season);

    const { rows: doneRows } = await db.query<{ any_done: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM sowing_events se
         JOIN gardens g ON g.id = se.garden_id
         WHERE g.owner_id = $1 AND se.season = $2 AND se.marked_done_at IS NOT NULL
       ) AS any_done`,
      [accountId, season],
    );

    const { rows: recentRows } = await db.query<{
      id: string;
      common_name: string | null;
      harvest_date: string;
      quantity: string | null;
      unit: string | null;
      garden_name: string;
      bed_label: string | null;
    }>(
      `SELECT h.id::text, ${COMMON_NAME} AS common_name,
              to_char(${LOCAL_DATE}, 'YYYY-MM-DD') AS harvest_date,
              h.quantity::text, h.unit, g.name AS garden_name, b.label AS bed_label
       ${ENTRY_FROM}
       ORDER BY h.harvested_at DESC, h.id DESC
       LIMIT ${RECENT_LIMIT}`,
      [accountId],
    );

    const totalsAll = computeTotals(entries);
    const totals =
      gardenId === null
        ? totalsAll
        : computeTotals(entries.filter((e) => e.garden_id === gardenId));

    const timing = await buildTiming(accountId, season, gardens);
    const trend = await buildTrend(accountId, season, totalsAll);
    const paid = isSupporter
      ? await buildPaid(accountId, season, entries, totalsAll, timing, season === nowSeason)
      : null;

    const dates = entries.map((e) => e.harvest_date).sort();

    const body = {
      season,
      currentSeason: nowSeason,
      readOnly: season < nowSeason,
      isSupporter,
      gardens: gardens.map((g) => ({ id: g.id, name: g.name })),
      empty: entries.length === 0 && !doneRows[0].any_done,
      summary: {
        harvestCount: entries.length,
        firstHarvestDate: dates[0] ?? null,
        lastHarvestDate: dates[dates.length - 1] ?? null,
      },
      totals: totals.map(formatTotal),
      recent: recentRows.map((r) => ({
        id: r.id,
        commonName: r.common_name,
        harvestDate: r.harvest_date,
        quantity: r.quantity === null ? null : Number(r.quantity),
        unit: r.unit,
        gardenName: r.garden_name,
        bedLabel: r.bed_label,
      })),
      timing: timing.map((t) => ({
        seedId: t.seedId,
        cambiumSeedId: t.cambiumSeedId,
        gardenId: t.gardenId,
        commonName: t.commonName,
        sowDate: t.sowDate,
        sowDateSource: t.sowDateSource,
        window: t.window,
        status: t.status,
        weeks: t.weeks,
      })),
      trend,
      paid,
    };

    // A weather outage shouldn't stick for the cache TTL; rebuild next read.
    if (!paid?.weather.historyUnavailable) metricsCache.set(cacheKey, body);
    return res.json(body);
  } catch (err) {
    logger.error('GET /api/metrics/dashboard failed', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/metrics/comparable-plants ────────────────────────────────────────

router.get('/comparable-plants', async (req: Request, res: Response) => {
  const session = req.session as SessionData;
  const accountId = session.account!.id;

  try {
    const { rows } = await db.query<{
      seed_id: string | null;
      cambium_seed_id: string | null;
      common_name: string | null;
      scientific_name: string | null;
      seasons: number[];
    }>(
      `SELECT seed_id, cambium_seed_id, common_name, scientific_name,
              array_agg(DISTINCT season ORDER BY season DESC) AS seasons
       FROM (
         SELECT ${ENTRY_PLANT_COLUMNS},
                ${SCIENTIFIC_NAME} AS scientific_name,
                ${SEASON_OF_ENTRY} AS season
         ${ENTRY_FROM}
           AND (h.seed_id IS NOT NULL OR h.cambium_seed_id IS NOT NULL)
       ) e
       GROUP BY seed_id, cambium_seed_id, common_name, scientific_name
       HAVING COUNT(DISTINCT season) >= 2
       ORDER BY common_name, seed_id, cambium_seed_id`,
      [accountId],
    );

    return res.json({
      data: rows.map((r) => ({
        seedId: r.seed_id,
        cambiumSeedId: r.cambium_seed_id,
        commonName: r.common_name,
        scientificName: r.scientific_name,
        seasons: r.seasons,
      })),
    });
  } catch (err) {
    logger.error('GET /api/metrics/comparable-plants failed', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/metrics/cross-season ─────────────────────────────────────────────

interface PlantEntryRow extends EntryRow {
  season: number;
  bed_label: string | null;
  notes: string | null;
}

function parseSeasonList(v: unknown): number[] | { error: string } {
  if (typeof v !== 'string') return { error: 'seasons must be given once' };
  const seasons = new Set<number>();
  for (const part of v.split(',')) {
    const s = parseSeason(part.trim());
    if (s === null) return { error: 'seasons must be comma-separated years between 2000 and 2100' };
    seasons.add(s);
  }
  if (seasons.size > MAX_COMPARE_SEASONS) {
    return { error: `Compare up to ${MAX_COMPARE_SEASONS} seasons.` };
  }
  return [...seasons].sort((a, b) => a - b);
}

router.get('/cross-season', requireSupporter, async (req: Request, res: Response) => {
  const session = req.session as SessionData;
  const accountId = session.account!.id;

  const plant = parsePlantKey(req.query.plant);
  if (!plant) {
    return res.status(400).json({ error: 'plant must be "seed:<id>" or "cambium:<id>"' });
  }

  let requested: number[] | null = null;
  if (req.query.seasons !== undefined) {
    const parsed = parseSeasonList(req.query.seasons);
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });
    requested = parsed;
  }

  let gardenId: string | null = null;
  if (req.query.gardenId !== undefined) {
    if (!isNumericId(req.query.gardenId)) {
      return res.status(400).json({ error: 'gardenId must be numeric' });
    }
    gardenId = String(parseInt(req.query.gardenId, 10));
  }

  let bedId: string | null = null;
  if (req.query.bedId !== undefined) {
    bedId = parseIntId(req.query.bedId);
    if (bedId === null) return res.status(400).json({ error: 'bedId must be a positive integer' });
  }

  try {
    const gardens = await loadGardens(accountId);
    if (gardenId !== null && !gardens.some((g) => g.id === gardenId)) {
      return res.status(404).json({ error: 'Garden not found' });
    }

    if (bedId !== null) {
      // The bed must be in the chosen garden, or in one of the account's
      // gardens when no garden is chosen.
      const { rows } = await db.query<{ garden_id: string }>(
        `SELECT b.garden_id::text FROM beds b
         JOIN gardens g ON g.id = b.garden_id
         WHERE b.id = $1 AND g.owner_id = $2`,
        [bedId, accountId],
      );
      if (rows.length === 0 || (gardenId !== null && rows[0].garden_id !== gardenId)) {
        return res.status(400).json({ error: 'bed not found in this garden' });
      }
    }

    // Every entry for this plant across all seasons and gardens. Available
    // seasons and the bed list ignore the garden / bed filter so the controls
    // stay stable while filtering.
    const { rows: all } = await db.query<PlantEntryRow>(
      `SELECT h.id::text, h.garden_id::text, h.bed_id::text, ${ENTRY_PLANT_COLUMNS},
              h.sowing_event_id::text AS sowing_event_id,
              to_char(${LOCAL_DATE}, 'YYYY-MM-DD') AS harvest_date,
              ${SEASON_OF_ENTRY} AS season,
              h.quantity::text, h.unit, b.label AS bed_label, h.notes
       ${ENTRY_FROM} AND ${seedKeyWhere(plant, '$2', 'h.')}
       ORDER BY h.harvested_at, h.id`,
      [accountId, plant.id],
    );

    const availableSeasons = [...new Set(all.map((e) => e.season))].sort((a, b) => b - a);
    if (availableSeasons.length < 2) {
      return res.status(404).json({ error: 'Not enough seasons for this plant.' });
    }

    // Entries already proved the plant is the account's, so the seed lookup
    // needs no ownership check.
    const { rows: info } = await db.query<{
      common_name: string | null;
      scientific_name: string | null;
      maturity_days_min: number | null;
      maturity_days_max: number | null;
    }>(
      `SELECT common_name, scientific_name, maturity_days_min, maturity_days_max
       FROM ${plant.kind === 'seed' ? 'seeds' : 'cambium.seeds'} WHERE id = $1`,
      [plant.id],
    );
    const seed = info[0] ?? null;
    const predicted =
      seed && seed.maturity_days_min !== null && seed.maturity_days_max !== null
        ? { min: seed.maturity_days_min, max: seed.maturity_days_max }
        : null;

    const selected = requested ?? availableSeasons.slice(0, 2).sort((a, b) => a - b);

    const filtered = all.filter(
      (e) =>
        selected.includes(e.season) &&
        (gardenId === null || e.garden_id === gardenId) &&
        (bedId === null || e.bed_id === bedId),
    );
    const unit = dominantUnit(filtered);

    // First harvest per sowing event, from all of the plant's entries — the
    // garden and bed filters don't apply to the linked harvests.
    const firstHarvest = firstHarvestBySowingEvent(all);

    const seasons = [];
    for (const season of selected) {
      const list = filtered.filter((e) => e.season === season);
      const { total, mixedUnits } = sumInUnit(list, unit);
      const dates = list.map((e) => e.harvest_date).sort();

      // Same candidate rule as the dashboard's timing card. When the plant was
      // sown (and harvested) in more than one garden and no garden is chosen,
      // the earliest sow date stands for the season.
      const candidates = (await loadSowingCandidates(accountId, season, plant))
        .filter((c) => gardenId === null || c.garden_id === gardenId)
        .map((c) => ({ ...sowDateOf(c), gardenId: c.garden_id, id: c.id }))
        .sort((a, b) => cmp(a.sowDate, b.sowDate) || Number(a.gardenId) - Number(b.gardenId));
      const sown = candidates[0] ?? null;
      const first = sown ? firstHarvest.get(sown.id) : undefined;

      seasons.push({
        season,
        total,
        mixedUnits,
        entryCount: list.length,
        firstDate: dates[0] ?? null,
        lastDate: dates[dates.length - 1] ?? null,
        avgDaysBetween: avgDaysBetween(dates),
        sowing: sown
          ? {
              sowDate: sown.sowDate,
              sowDateSource: sown.sowDateSource,
              daysToFirstHarvest: first === undefined ? null : daysBetween(sown.sowDate, first),
            }
          : null,
        predicted,
        entries: list.map((e) => ({
          id: e.id,
          harvestDate: e.harvest_date,
          quantity: e.quantity === null ? null : Number(e.quantity),
          unit: e.unit,
          bedLabel: e.bed_label,
          notesExcerpt: notesExcerpt(e.notes),
        })),
      });
    }

    const beds = new Map<string, { id: string; label: string; gardenId: string }>();
    for (const e of all) {
      if (e.bed_id !== null && !beds.has(e.bed_id)) {
        beds.set(e.bed_id, { id: e.bed_id, label: e.bed_label ?? '', gardenId: e.garden_id });
      }
    }

    return res.json({
      plant: {
        seedId: plant.kind === 'seed' ? String(plant.id) : null,
        cambiumSeedId: plant.kind === 'cambium' ? String(plant.id) : null,
        commonName: seed?.common_name ?? all[0].common_name,
        scientificName: seed?.scientific_name ?? null,
      },
      availableSeasons,
      unit,
      gardens: gardens.map((g) => ({ id: g.id, name: g.name })),
      beds: [...beds.values()].sort(
        (a, b) =>
          Number(a.gardenId) - Number(b.gardenId) ||
          a.label.localeCompare(b.label) ||
          Number(a.id) - Number(b.id),
      ),
      seasons,
    });
  } catch (err) {
    logger.error('GET /api/metrics/cross-season failed', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;

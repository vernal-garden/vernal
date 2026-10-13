import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import type { PoolClient } from 'pg';
import { db } from '../lib/db';
import { requireAuth, requireSession, requireSupporter } from '../middleware/auth';
import { writeLimiter } from '../middleware/rateLimiters';
import { isNumericId } from '../lib/validation';
import { currentSeason, isIsoDate } from '../lib/plantingSchedule';
import { recomputeHarvestableCount } from '../lib/gardenBadges';
import { getPresignedUploadUrl, deleteFromR2 } from '../lib/r2';
import { logger } from '../lib/logger';
import type { SessionData } from '../types';

const router = Router();
router.use(requireSession);

// ── Constants ─────────────────────────────────────────────────────────────────

// harvestDate is a calendar date. It's stored as noon Pacific on that date so
// it reads back as the same date regardless of server or client time zone.
const TZ = 'America/Los_Angeles';
const LOCAL_DATE = `(h.harvested_at AT TIME ZONE '${TZ}')::date`;

const UNITS = ['g', 'kg', 'oz', 'lb', 'count'] as const;
const MAX_QUANTITY = 100000;
const MAX_NOTES_LENGTH = 5000;
const MAX_PHOTOS = 3;
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_PLANT_OPTIONS = 30;
const STORAGE_UNAVAILABLE = 'Photo storage is not configured.';
const TOO_MANY_PHOTOS = `Up to ${MAX_PHOTOS} photos per harvest.`;

const PACIFIC_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function todayPacific(): string {
  return PACIFIC_DATE.format(new Date());
}

// ── Types ─────────────────────────────────────────────────────────────────────

// An entry is keyed by its personal seed when it has one, otherwise by its
// Cambium seed — the same rule the planting guide uses.
type SeedKey = { kind: 'seed'; id: number } | { kind: 'cambium'; id: number };

interface Photo {
  key: string;
  url: string;
}

interface EntryRow {
  id: string;
  garden_id: string;
  garden_name: string;
  bed_id: string | null;
  bed_label: string | null;
  seed_id: string | null;
  cambium_seed_id: string | null;
  common_name: string | null;
  scientific_name: string | null;
  harvest_date: string;
  season: number;
  quantity: string | null;
  unit: string | null;
  quality_rating: number | null;
  notes: string | null;
  photos: Photo[];
  sowing_event_id: string | null;
  created_at: Date;
  cursor_ts: string;
}

const COMMON_NAME = 'CASE WHEN h.seed_id IS NOT NULL THEN s.common_name ELSE cs.common_name END';
const SCIENTIFIC_NAME =
  'CASE WHEN h.seed_id IS NOT NULL THEN s.scientific_name ELSE cs.scientific_name END';

// $1 = account id (or null), $2 = session id. Only entries in a garden the
// session owns are ever visible.
const ENTRY_SELECT = `
  SELECT h.id::text, h.garden_id::text, g.name AS garden_name,
         h.bed_id::text, b.label AS bed_label,
         h.seed_id::text, h.cambium_seed_id::text,
         ${COMMON_NAME} AS common_name,
         ${SCIENTIFIC_NAME} AS scientific_name,
         to_char(${LOCAL_DATE}, 'YYYY-MM-DD') AS harvest_date,
         EXTRACT(YEAR FROM ${LOCAL_DATE})::int AS season,
         h.quantity::text, h.unit, h.quality_rating, h.notes, h.photos,
         h.sowing_event_id::text, h.created_at,
         to_char(h.harvested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts
  FROM harvest_entries h
  JOIN gardens g ON g.id = h.garden_id
  LEFT JOIN beds b ON b.id = h.bed_id
  LEFT JOIN seeds s ON s.id = h.seed_id
  LEFT JOIN cambium.seeds cs ON cs.id = h.cambium_seed_id
  WHERE (g.owner_id = $1 OR g.guest_session_id = $2)`;

function formatEntry(row: EntryRow) {
  return {
    id: row.id,
    gardenId: row.garden_id,
    gardenName: row.garden_name,
    bedId: row.bed_id,
    bedLabel: row.bed_label,
    seedId: row.seed_id,
    cambiumSeedId: row.cambium_seed_id,
    commonName: row.common_name,
    scientificName: row.scientific_name,
    harvestDate: row.harvest_date,
    season: row.season,
    quantity: row.quantity === null ? null : Number(row.quantity),
    unit: row.unit,
    qualityRating: row.quality_rating,
    notes: row.notes,
    photos: row.photos.map((p) => ({ key: p.key, url: p.url })),
    sowingEventId: row.sowing_event_id,
    createdAt: row.created_at,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function owner(session: SessionData): [number | null, string] {
  return [session.account?.id ?? null, session.id];
}

function bodyOf(req: Request): Record<string, unknown> | null {
  const body: unknown = req.body;
  return body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

function parsePositiveInt(v: unknown): number | null {
  const n = typeof v === 'string' && isNumericId(v) ? parseInt(v, 10) : v;
  if (!Number.isInteger(n) || (n as number) <= 0) return null;
  return n as number;
}

// SQL predicate matching a SeedKey against seed_id / cambium_seed_id columns.
function seedKeyWhere(key: SeedKey, param: string, alias = ''): string {
  return key.kind === 'seed'
    ? `${alias}seed_id = ${param}`
    : `${alias}seed_id IS NULL AND ${alias}cambium_seed_id = ${param}`;
}

function seasonOf(date: string): number {
  return Number(date.slice(0, 4));
}

function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, '\\$&')}%`;
}

function isR2ConfigError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.message.startsWith('R2 not configured') || err.message.endsWith('is not set.'))
  );
}

function publicBaseUrl(): string | null {
  const u = process.env.R2_PUBLIC_BASE_URL;
  return u ? u.replace(/\/$/, '') : null;
}

// Fire-and-forget: a failed R2 delete leaves an orphan object, never a failed request.
function deletePhotoObject(key: string): void {
  // Wrapped so a synchronous throw (R2 not configured) is caught the same way.
  Promise.resolve()
    .then(() => deleteFromR2(key))
    .catch((err: unknown) => {
      logger.warn('harvest photo R2 delete failed', {
        key,
        errMsg: err instanceof Error ? err.message : String(err),
      });
    });
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // connection already broken — release() below discards it
  }
}

type Queryable = Pick<PoolClient, 'query'>;

async function ownsGarden(q: Queryable, gardenId: number, session: SessionData): Promise<boolean> {
  const { rows } = await q.query(
    'SELECT 1 FROM gardens WHERE id = $1 AND (owner_id = $2 OR guest_session_id = $3)',
    [gardenId, ...owner(session)],
  );
  return rows.length > 0;
}

// Personal seeds must belong to the session; Cambium seeds must exist.
async function seedExists(q: Queryable, key: SeedKey, session: SessionData): Promise<boolean> {
  const { rows } =
    key.kind === 'seed'
      ? await q.query(
          'SELECT 1 FROM seeds WHERE id = $1 AND (owner_id = $2 OR guest_session_id = $3)',
          [key.id, ...owner(session)],
        )
      : await q.query('SELECT 1 FROM cambium.seeds WHERE id = $1', [key.id]);
  return rows.length > 0;
}

async function bedInGarden(q: Queryable, bedId: number, gardenId: number): Promise<boolean> {
  const { rows } = await q.query('SELECT 1 FROM beds WHERE id = $1 AND garden_id = $2', [
    bedId,
    gardenId,
  ]);
  return rows.length > 0;
}

async function sowingEventMatches(
  q: Queryable,
  eventId: number,
  gardenId: number,
  key: SeedKey,
): Promise<boolean> {
  const { rows } = await q.query(
    `SELECT 1 FROM sowing_events WHERE id = $1 AND garden_id = $2 AND ${seedKeyWhere(key, '$3')}`,
    [eventId, gardenId, key.id],
  );
  return rows.length > 0;
}

async function fetchEntry(
  q: Queryable,
  entryId: number | string,
  session: SessionData,
): Promise<EntryRow | null> {
  const { rows } = await q.query<EntryRow>(`${ENTRY_SELECT} AND h.id = $3`, [
    ...owner(session),
    entryId,
  ]);
  return rows[0] ?? null;
}

// Locks the entry row; null when it doesn't exist or isn't in an owned garden.
async function lockEntry(
  client: PoolClient,
  entryId: string,
  session: SessionData,
): Promise<{
  garden_id: number;
  bed_id: number | null;
  seed_id: number | null;
  cambium_seed_id: number | null;
  quantity: string | null;
  unit: string | null;
  photos: Photo[];
} | null> {
  const { rows } = await client.query(
    `SELECT h.garden_id, h.bed_id, h.seed_id, h.cambium_seed_id, h.quantity::text, h.unit, h.photos
     FROM harvest_entries h
     JOIN gardens g ON g.id = h.garden_id
     WHERE h.id = $1 AND (g.owner_id = $2 OR g.guest_session_id = $3)
     FOR UPDATE OF h`,
    [entryId, ...owner(session)],
  );
  return rows[0] ?? null;
}

// ── Body validation ───────────────────────────────────────────────────────────

interface EntryInput {
  gardenId?: number;
  seedKey?: SeedKey;
  bedId?: number | null;
  harvestDate?: string;
  quantity?: number | null;
  unit?: string | null;
  qualityRating?: number | null;
  notes?: string | null;
  sowingEventId?: number | null;
}

function parseSeedKey(body: Record<string, unknown>): SeedKey | { error: string } {
  const hasSeedId = body.seedId !== undefined && body.seedId !== null;
  const hasCambiumSeedId = body.cambiumSeedId !== undefined && body.cambiumSeedId !== null;
  if (hasSeedId === hasCambiumSeedId) {
    return { error: 'provide exactly one of seedId or cambiumSeedId' };
  }
  if (hasSeedId) {
    const id = parsePositiveInt(body.seedId);
    return id === null ? { error: 'seedId must be a positive integer' } : { kind: 'seed', id };
  }
  const id = parsePositiveInt(body.cambiumSeedId);
  return id === null
    ? { error: 'cambiumSeedId must be a positive integer' }
    : { kind: 'cambium', id };
}

// Shape checks only; ownership and cross-row checks happen in the transaction.
function parseEntryBody(
  body: Record<string, unknown>,
  mode: 'create' | 'update',
): EntryInput | { error: string } {
  const input: EntryInput = {};

  if (body.gardenId !== undefined || mode === 'create') {
    const id = parsePositiveInt(body.gardenId);
    if (id === null) return { error: 'gardenId must be a positive integer' };
    input.gardenId = id;
  }

  if (body.seedId !== undefined || body.cambiumSeedId !== undefined || mode === 'create') {
    const key = parseSeedKey(body);
    if ('error' in key) return key;
    input.seedKey = key;
  }

  if (body.bedId !== undefined) {
    if (body.bedId === null) input.bedId = null;
    else {
      const id = parsePositiveInt(body.bedId);
      if (id === null) return { error: 'bedId must be a positive integer or null' };
      input.bedId = id;
    }
  }

  if (body.harvestDate !== undefined) {
    if (!isIsoDate(body.harvestDate)) {
      return { error: 'harvestDate must be a YYYY-MM-DD date' };
    }
    if (body.harvestDate > todayPacific()) {
      return { error: 'harvestDate cannot be in the future' };
    }
    input.harvestDate = body.harvestDate;
  }

  if (body.quantity !== undefined) {
    const v = body.quantity;
    if (
      v !== null &&
      (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > MAX_QUANTITY)
    ) {
      return { error: `quantity must be a number from 0 to ${MAX_QUANTITY}, or null` };
    }
    input.quantity = v;
  }

  if (body.unit !== undefined) {
    const v = body.unit;
    if (v !== null && !(UNITS as readonly unknown[]).includes(v)) {
      return { error: `unit must be one of ${UNITS.join(', ')}, or null` };
    }
    input.unit = v as string | null;
  }

  if (body.qualityRating !== undefined) {
    const v = body.qualityRating;
    if (v !== null && (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 5)) {
      return { error: 'qualityRating must be an integer from 1 to 5, or null' };
    }
    input.qualityRating = v as number | null;
  }

  if (body.notes !== undefined) {
    const v = body.notes;
    if (v !== null && typeof v !== 'string') return { error: 'notes must be text or null' };
    const trimmed = v === null ? '' : v.trim();
    if (trimmed.length > MAX_NOTES_LENGTH) {
      return { error: `notes must be ${MAX_NOTES_LENGTH} characters or fewer` };
    }
    input.notes = trimmed || null;
  }

  if (body.sowingEventId !== undefined) {
    if (body.sowingEventId === null) input.sowingEventId = null;
    else {
      const id = parsePositiveInt(body.sowingEventId);
      if (id === null) return { error: 'sowingEventId must be a positive integer or null' };
      input.sowingEventId = id;
    }
  }

  return input;
}

function quantityUnitError(quantity: unknown, unit: unknown): string | null {
  if ((quantity === null) !== (unit === null)) {
    return 'quantity and unit must be given together';
  }
  return null;
}

// ── List filters (shared by GET / and GET /export.csv) ────────────────────────

interface Filters {
  season: number | null;
  gardenId: number | null;
  seeds: SeedKey[];
  from: string | null;
  to: string | null;
  q: string | null;
}

function parseFilters(query: Request['query']): Filters | { error: string } {
  const f: Filters = { season: null, gardenId: null, seeds: [], from: null, to: null, q: null };

  for (const name of ['season', 'gardenId', 'from', 'to', 'q', 'cursor', 'limit']) {
    if (query[name] !== undefined && typeof query[name] !== 'string') {
      return { error: `${name} must be given once` };
    }
  }

  if (query.season !== undefined) {
    const v = query.season as string;
    if (!/^\d{4}$/.test(v)) return { error: 'season must be a year' };
    f.season = Number(v);
  }

  if (query.gardenId !== undefined) {
    const id = parsePositiveInt(query.gardenId);
    if (id === null) return { error: 'gardenId must be a positive integer' };
    f.gardenId = id;
  }

  if (query.seed !== undefined) {
    const values = Array.isArray(query.seed) ? query.seed : [query.seed];
    for (const v of values) {
      const m = typeof v === 'string' ? /^(seed|cambium):(\d+)$/.exec(v) : null;
      const id = m ? parsePositiveInt(m[2]) : null;
      if (!m || id === null) return { error: 'seed must be "seed:<id>" or "cambium:<id>"' };
      f.seeds.push({ kind: m[1] as SeedKey['kind'], id });
    }
  }

  for (const name of ['from', 'to'] as const) {
    if (query[name] !== undefined) {
      if (!isIsoDate(query[name])) return { error: `${name} must be a YYYY-MM-DD date` };
      f[name] = query[name] as string;
    }
  }

  if (query.q !== undefined) {
    const q = (query.q as string).trim();
    f.q = q || null;
  }

  return f;
}

// Appends the filter conditions to an ENTRY_SELECT query, pushing params.
function filterSql(f: Filters, params: unknown[]): string {
  const conditions: string[] = [];
  const add = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };

  if (f.season !== null) conditions.push(`EXTRACT(YEAR FROM ${LOCAL_DATE})::int = ${add(f.season)}`);
  if (f.gardenId !== null) conditions.push(`h.garden_id = ${add(f.gardenId)}`);
  if (f.seeds.length > 0) {
    const ors = f.seeds.map((k) => `(${seedKeyWhere(k, add(k.id), 'h.')})`);
    conditions.push(`(${ors.join(' OR ')})`);
  }
  if (f.from !== null) conditions.push(`${LOCAL_DATE} >= ${add(f.from)}::date`);
  if (f.to !== null) conditions.push(`${LOCAL_DATE} <= ${add(f.to)}::date`);
  if (f.q !== null) {
    const p = add(likePattern(f.q));
    conditions.push(`((${COMMON_NAME}) ILIKE ${p} OR h.notes ILIKE ${p})`);
  }

  return conditions.map((c) => ` AND ${c}`).join('');
}

// Opaque cursor: base64 of [harvested_at as an ISO timestamp, id].
function encodeCursor(row: EntryRow): string {
  return Buffer.from(JSON.stringify([row.cursor_ts, Number(row.id)])).toString('base64');
}

function decodeCursor(v: string): [string, number] | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(v, 'base64').toString('utf8'));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(parsed[0]) &&
      !Number.isNaN(Date.parse(parsed[0])) &&
      Number.isInteger(parsed[1]) &&
      parsed[1] > 0
    ) {
      return [parsed[0], parsed[1]];
    }
  } catch {
    // fall through
  }
  return null;
}

// ── GET /api/harvests ─────────────────────────────────────────────────────────

router.get('/', async (req: Request, res: Response) => {
  const session = req.session as SessionData;

  const filters = parseFilters(req.query);
  if ('error' in filters) return res.status(400).json({ error: filters.error });

  let limit = DEFAULT_LIMIT;
  if (req.query.limit !== undefined) {
    const n = parsePositiveInt(req.query.limit);
    if (n === null || n > MAX_LIMIT) {
      return res.status(400).json({ error: `limit must be an integer from 1 to ${MAX_LIMIT}` });
    }
    limit = n;
  }

  let cursor: [string, number] | null = null;
  if (req.query.cursor !== undefined) {
    cursor = decodeCursor(req.query.cursor as string);
    if (cursor === null) return res.status(400).json({ error: 'Invalid cursor' });
  }

  try {
    if (filters.gardenId !== null && !(await ownsGarden(db, filters.gardenId, session))) {
      return res.status(404).json({ error: 'Garden not found' });
    }

    const params: unknown[] = [...owner(session)];
    let sql = ENTRY_SELECT + filterSql(filters, params);
    if (cursor) {
      params.push(cursor[0], cursor[1]);
      sql += ` AND (h.harvested_at, h.id) < ($${params.length - 1}::timestamptz, $${params.length}::int)`;
    }
    params.push(limit + 1);
    sql += ` ORDER BY h.harvested_at DESC, h.id DESC LIMIT $${params.length}`;

    const { rows } = await db.query<EntryRow>(sql, params);
    const page = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? encodeCursor(page[page.length - 1]) : null;

    const { rows: seasonRows } = await db.query<{ season: number }>(
      `SELECT DISTINCT EXTRACT(YEAR FROM ${LOCAL_DATE})::int AS season
       FROM harvest_entries h
       JOIN gardens g ON g.id = h.garden_id
       WHERE g.owner_id = $1 OR g.guest_session_id = $2
       ORDER BY season DESC`,
      owner(session),
    );

    return res.json({
      data: page.map(formatEntry),
      nextCursor,
      seasons: seasonRows.map((r) => r.season),
    });
  } catch (err) {
    logger.error('GET /api/harvests failed', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/harvests/export.csv ──────────────────────────────────────────────

const CSV_HEADER = [
  'Date',
  'Plant',
  'Scientific name',
  'Garden',
  'Bed',
  'Quantity',
  'Unit',
  'Quality',
  'Notes',
  'Photos',
  'Linked sowing',
];

// RFC 4180 quoting, plus a leading quote on anything a spreadsheet would read
// as a formula.
function csvCell(v: string | number | null): string {
  let s = v === null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

router.get('/export.csv', async (req: Request, res: Response) => {
  const session = req.session as SessionData;

  const filters = parseFilters(req.query);
  if ('error' in filters) return res.status(400).json({ error: filters.error });

  try {
    if (filters.gardenId !== null && !(await ownsGarden(db, filters.gardenId, session))) {
      return res.status(404).json({ error: 'Garden not found' });
    }

    const params: unknown[] = [...owner(session)];
    const sql =
      ENTRY_SELECT + filterSql(filters, params) + ' ORDER BY h.harvested_at DESC, h.id DESC';
    const { rows } = await db.query<EntryRow>(sql, params);

    const lines = [CSV_HEADER.map(csvCell).join(',')];
    for (const r of rows) {
      lines.push(
        [
          r.harvest_date,
          r.common_name,
          r.scientific_name,
          r.garden_name,
          r.bed_label,
          r.quantity === null ? null : Number(r.quantity),
          r.unit,
          r.quality_rating,
          r.notes,
          r.photos.length,
          r.sowing_event_id !== null ? 'yes' : 'no',
        ]
          .map(csvCell)
          .join(','),
      );
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="vernal-harvest-log-${todayPacific()}.csv"`,
    );
    return res.send(lines.join('\r\n') + '\r\n');
  } catch (err) {
    logger.error('GET /api/harvests/export.csv failed', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/harvests/plant-options ───────────────────────────────────────────

interface OptionRow {
  seed_id: string | null;
  cambium_seed_id: string | null;
  common_name: string | null;
  scientific_name: string | null;
}

router.get('/plant-options', async (req: Request, res: Response) => {
  const session = req.session as SessionData;

  if (req.query.q !== undefined && typeof req.query.q !== 'string') {
    return res.status(400).json({ error: 'q must be given once' });
  }
  const q = ((req.query.q as string | undefined) ?? '').trim();
  const pattern = q ? likePattern(q) : null;

  try {
    const { rows: planted } = await db.query<OptionRow>(
      `SELECT DISTINCT p.seed_id::text,
              CASE WHEN p.seed_id IS NULL THEN p.cambium_seed_id::text END AS cambium_seed_id,
              CASE WHEN p.seed_id IS NOT NULL THEN s.common_name ELSE cs.common_name END AS common_name,
              CASE WHEN p.seed_id IS NOT NULL THEN s.scientific_name ELSE cs.scientific_name END AS scientific_name
       FROM plantings p
       JOIN gardens g ON g.id = p.garden_id
       LEFT JOIN seeds s ON s.id = p.seed_id
       LEFT JOIN cambium.seeds cs ON cs.id = p.cambium_seed_id
       WHERE (g.owner_id = $1 OR g.guest_session_id = $2)
         AND p.season = $3
         AND ($4::text IS NULL
              OR (CASE WHEN p.seed_id IS NOT NULL THEN s.common_name ELSE cs.common_name END) ILIKE $4
              OR (CASE WHEN p.seed_id IS NOT NULL THEN s.scientific_name ELSE cs.scientific_name END) ILIKE $4)
       ORDER BY common_name, seed_id, cambium_seed_id
       LIMIT ${MAX_PLANT_OPTIONS}`,
      [...owner(session), currentSeason(new Date()), pattern],
    );

    const { rows: personal } = await db.query<OptionRow>(
      `SELECT id::text AS seed_id, NULL AS cambium_seed_id, common_name, scientific_name
       FROM seeds
       WHERE (owner_id = $1 OR guest_session_id = $2)
         AND ($3::text IS NULL OR common_name ILIKE $3 OR scientific_name ILIKE $3)
       ORDER BY common_name, id
       LIMIT ${MAX_PLANT_OPTIONS}`,
      [...owner(session), pattern],
    );

    let cambium: OptionRow[] = [];
    if (q.length >= 2) {
      ({ rows: cambium } = await db.query<OptionRow>(
        `SELECT NULL AS seed_id, id::text AS cambium_seed_id, common_name, scientific_name
         FROM cambium.seeds
         WHERE moderation_status = 'active'
           AND (common_name ILIKE $1 OR scientific_name ILIKE $1)
         ORDER BY common_name, id
         LIMIT ${MAX_PLANT_OPTIONS}`,
        [pattern],
      ));
    }

    const seen = new Set<string>();
    const options = [];
    const groups = [
      ['planted', planted],
      ['personal', personal],
      ['cambium', cambium],
    ] as const;
    for (const [source, rows] of groups) {
      for (const r of rows) {
        const key = r.seed_id !== null ? `seed:${r.seed_id}` : `cambium:${r.cambium_seed_id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        options.push({
          seedId: r.seed_id,
          cambiumSeedId: r.seed_id !== null ? null : r.cambium_seed_id,
          commonName: r.common_name,
          scientificName: r.scientific_name,
          source,
        });
      }
    }

    return res.json({ data: options.slice(0, MAX_PLANT_OPTIONS) });
  } catch (err) {
    logger.error('GET /api/harvests/plant-options failed', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/harvests/:id ─────────────────────────────────────────────────────

router.get('/:id', async (req: Request, res: Response) => {
  const session = req.session as SessionData;
  const id = req.params.id as string;
  if (!isNumericId(id)) return res.status(400).json({ error: 'Invalid id' });

  try {
    const entry = await fetchEntry(db, id, session);
    if (!entry) return res.status(404).json({ error: 'Harvest not found' });
    return res.json(formatEntry(entry));
  } catch (err) {
    logger.error('GET /api/harvests/:id failed', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/harvests ────────────────────────────────────────────────────────

router.post('/', writeLimiter, async (req: Request, res: Response) => {
  const session = req.session as SessionData;
  const body = bodyOf(req);
  if (!body) return res.status(400).json({ error: 'body must be a JSON object' });

  const input = parseEntryBody(body, 'create');
  if ('error' in input) return res.status(400).json({ error: input.error });

  const gardenId = input.gardenId!;
  const seedKey = input.seedKey!;
  const harvestDate = input.harvestDate ?? todayPacific();
  const season = seasonOf(harvestDate);
  const quantity = input.quantity ?? null;
  const unit = input.unit ?? null;

  const pairErr = quantityUnitError(quantity, unit);
  if (pairErr) return res.status(400).json({ error: pairErr });

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    if (!(await ownsGarden(client, gardenId, session))) {
      await rollback(client);
      return res.status(404).json({ error: 'Garden not found' });
    }
    if (!(await seedExists(client, seedKey, session))) {
      await rollback(client);
      return res.status(400).json({ error: 'seed not found' });
    }
    if (input.bedId != null && !(await bedInGarden(client, input.bedId, gardenId))) {
      await rollback(client);
      return res.status(400).json({ error: 'bed not found in this garden' });
    }

    let sowingEventId: number | null = null;
    if (input.sowingEventId != null) {
      if (!(await sowingEventMatches(client, input.sowingEventId, gardenId, seedKey))) {
        await rollback(client);
        return res.status(400).json({ error: 'sowing event not found for this garden and seed' });
      }
      sowingEventId = input.sowingEventId;
    } else if (input.sowingEventId === undefined) {
      const { rows } = await client.query<{ id: number }>(
        `SELECT id FROM sowing_events
         WHERE garden_id = $1 AND ${seedKeyWhere(seedKey, '$2')} AND season = $3
           AND marked_done_at IS NOT NULL
         ORDER BY id LIMIT 1`,
        [gardenId, seedKey.id, season],
      );
      sowingEventId = rows[0]?.id ?? null;
    }

    const { rows: inserted } = await client.query<{ id: number }>(
      `INSERT INTO harvest_entries
         (garden_id, bed_id, seed_id, cambium_seed_id, harvested_at, quantity, unit,
          quality_rating, notes, sowing_event_id)
       VALUES ($1, $2, $3, $4, ($5::date + time '12:00') AT TIME ZONE '${TZ}', $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        gardenId,
        input.bedId ?? null,
        seedKey.kind === 'seed' ? seedKey.id : null,
        seedKey.kind === 'cambium' ? seedKey.id : null,
        harvestDate,
        quantity,
        unit,
        input.qualityRating ?? null,
        input.notes ?? null,
        sowingEventId,
      ],
    );

    // Logging a harvest clears that plant's harvest-ready indicator.
    const dismissed = await client.query(
      `UPDATE plantings SET indicator_dismissed_at = NOW(), updated_at = NOW()
       WHERE garden_id = $1 AND ${seedKeyWhere(seedKey, '$2')} AND season = $3
         AND harvest_ready = true AND indicator_dismissed_at IS NULL`,
      [gardenId, seedKey.id, season],
    );
    if ((dismissed.rowCount ?? 0) > 0) {
      await recomputeHarvestableCount(client, gardenId);
    }

    const entry = await fetchEntry(client, inserted[0].id, session);
    await client.query('COMMIT');
    return res.status(201).json(formatEntry(entry!));
  } catch (err) {
    await rollback(client);
    logger.error('POST /api/harvests failed', err);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ── PATCH /api/harvests/:id ───────────────────────────────────────────────────

router.patch('/:id', writeLimiter, async (req: Request, res: Response) => {
  const session = req.session as SessionData;
  const id = req.params.id as string;
  if (!isNumericId(id)) return res.status(400).json({ error: 'Invalid id' });

  const body = bodyOf(req);
  if (!body) return res.status(400).json({ error: 'body must be a JSON object' });

  const input = parseEntryBody(body, 'update');
  if ('error' in input) return res.status(400).json({ error: input.error });
  if (Object.keys(input).length === 0) {
    return res.status(400).json({ error: 'No fields to update' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const existing = await lockEntry(client, id, session);
    if (!existing) {
      await rollback(client);
      return res.status(404).json({ error: 'Harvest not found' });
    }

    const gardenChanged = input.gardenId !== undefined && input.gardenId !== existing.garden_id;
    const gardenId = input.gardenId ?? existing.garden_id;
    if (gardenChanged && !(await ownsGarden(client, gardenId, session))) {
      await rollback(client);
      return res.status(404).json({ error: 'Garden not found' });
    }

    if (input.seedKey && !(await seedExists(client, input.seedKey, session))) {
      await rollback(client);
      return res.status(400).json({ error: 'seed not found' });
    }
    const seedKey: SeedKey | null =
      input.seedKey ??
      (existing.seed_id !== null
        ? { kind: 'seed', id: existing.seed_id }
        : existing.cambium_seed_id !== null
          ? { kind: 'cambium', id: existing.cambium_seed_id }
          : null);

    // Moving to another garden drops the bed unless a new one comes with it.
    const bedId = input.bedId !== undefined ? input.bedId : gardenChanged ? null : existing.bed_id;
    if (input.bedId != null && !(await bedInGarden(client, input.bedId, gardenId))) {
      await rollback(client);
      return res.status(400).json({ error: 'bed not found in this garden' });
    }

    const quantity = input.quantity !== undefined ? input.quantity : existing.quantity;
    const unit = input.unit !== undefined ? input.unit : existing.unit;
    const pairErr = quantityUnitError(quantity, unit);
    if (pairErr) {
      await rollback(client);
      return res.status(400).json({ error: pairErr });
    }

    if (input.sowingEventId != null) {
      if (!seedKey || !(await sowingEventMatches(client, input.sowingEventId, gardenId, seedKey))) {
        await rollback(client);
        return res.status(400).json({ error: 'sowing event not found for this garden and seed' });
      }
    }

    const sets: string[] = [];
    const values: unknown[] = [];
    const set = (column: string, value: unknown, cast = '') => {
      values.push(value);
      sets.push(`${column} = $${values.length}${cast}`);
    };

    if (gardenChanged) set('garden_id', gardenId);
    if (input.bedId !== undefined || gardenChanged) set('bed_id', bedId);
    if (input.seedKey) {
      set('seed_id', input.seedKey.kind === 'seed' ? input.seedKey.id : null);
      set('cambium_seed_id', input.seedKey.kind === 'cambium' ? input.seedKey.id : null);
    }
    if (input.harvestDate !== undefined) {
      values.push(input.harvestDate);
      sets.push(`harvested_at = ($${values.length}::date + time '12:00') AT TIME ZONE '${TZ}'`);
    }
    if (input.quantity !== undefined) set('quantity', input.quantity);
    if (input.unit !== undefined) set('unit', input.unit);
    if (input.qualityRating !== undefined) set('quality_rating', input.qualityRating);
    if (input.notes !== undefined) set('notes', input.notes);
    if (input.sowingEventId !== undefined) set('sowing_event_id', input.sowingEventId);

    if (sets.length > 0) {
      values.push(id);
      await client.query(
        `UPDATE harvest_entries SET ${sets.join(', ')} WHERE id = $${values.length}`,
        values,
      );
    }

    const entry = await fetchEntry(client, id, session);
    await client.query('COMMIT');
    return res.json(formatEntry(entry!));
  } catch (err) {
    await rollback(client);
    logger.error('PATCH /api/harvests/:id failed', err);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ── DELETE /api/harvests/:id ──────────────────────────────────────────────────

router.delete('/:id', writeLimiter, async (req: Request, res: Response) => {
  const session = req.session as SessionData;
  const id = req.params.id as string;
  if (!isNumericId(id)) return res.status(400).json({ error: 'Invalid id' });

  try {
    const { rows } = await db.query<{ photos: Photo[] }>(
      `DELETE FROM harvest_entries h
       USING gardens g
       WHERE h.id = $1 AND g.id = h.garden_id AND (g.owner_id = $2 OR g.guest_session_id = $3)
       RETURNING h.photos`,
      [id, ...owner(session)],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Harvest not found' });

    for (const photo of rows[0].photos) deletePhotoObject(photo.key);
    return res.status(204).send();
  } catch (err) {
    logger.error('DELETE /api/harvests/:id failed', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Photos (supporters only) ──────────────────────────────────────────────────

const photoGuards = [requireAuth, requireSupporter, writeLimiter];

// POST /api/harvests/:id/photos/upload-url
router.post('/:id/photos/upload-url', ...photoGuards, async (req: Request, res: Response) => {
  const session = req.session as SessionData;
  const id = req.params.id as string;
  if (!isNumericId(id)) return res.status(400).json({ error: 'Invalid id' });

  try {
    const entry = await fetchEntry(db, id, session);
    if (!entry) return res.status(404).json({ error: 'Harvest not found' });
    if (entry.photos.length >= MAX_PHOTOS) {
      return res.status(409).json({ error: TOO_MANY_PHOTOS });
    }

    const body = bodyOf(req) ?? {};
    if (body.contentType !== 'image/jpeg') {
      return res.status(400).json({ error: 'Photos must be JPEG.' });
    }
    // The presigned PUT signs Content-Length, so the client must say how big
    // the file is up front.
    const size = body.size;
    if (typeof size !== 'number' || !Number.isInteger(size) || size < 1 || size > MAX_PHOTO_BYTES) {
      return res.status(400).json({ error: 'Photos must be 5 MB or smaller.' });
    }

    const key = `harvest-photos/${id}/${crypto.randomUUID()}.jpg`;
    let uploadUrl: string;
    try {
      uploadUrl = await getPresignedUploadUrl(key, 'image/jpeg', size, 300);
    } catch (err) {
      if (isR2ConfigError(err)) return res.status(503).json({ error: STORAGE_UNAVAILABLE });
      throw err;
    }

    return res.json({ uploadUrl, key });
  } catch (err) {
    logger.error('POST /api/harvests/:id/photos/upload-url failed', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/harvests/:id/photos
router.post('/:id/photos', ...photoGuards, async (req: Request, res: Response) => {
  const session = req.session as SessionData;
  const id = req.params.id as string;
  if (!isNumericId(id)) return res.status(400).json({ error: 'Invalid id' });

  const body = bodyOf(req) ?? {};

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Locked so concurrent attaches can't both pass the count check.
    const existing = await lockEntry(client, id, session);
    if (!existing) {
      await rollback(client);
      return res.status(404).json({ error: 'Harvest not found' });
    }

    const keyRe = new RegExp(`^harvest-photos/${id}/[0-9a-f-]{36}\\.jpg$`);
    if (typeof body.key !== 'string' || !keyRe.test(body.key)) {
      await rollback(client);
      return res.status(400).json({ error: 'Invalid photo key.' });
    }
    const key = body.key;

    if (existing.photos.length >= MAX_PHOTOS) {
      await rollback(client);
      return res.status(409).json({ error: TOO_MANY_PHOTOS });
    }
    if (existing.photos.some((p) => p.key === key)) {
      await rollback(client);
      return res.status(409).json({ error: 'Photo already added.' });
    }

    const base = publicBaseUrl();
    if (!base) {
      await rollback(client);
      return res.status(503).json({ error: STORAGE_UNAVAILABLE });
    }

    await client.query(
      `UPDATE harvest_entries SET photos = photos || jsonb_build_array($2::jsonb) WHERE id = $1`,
      [id, JSON.stringify({ key, url: `${base}/${key}` })],
    );

    const entry = await fetchEntry(client, id, session);
    await client.query('COMMIT');
    return res.json(formatEntry(entry!));
  } catch (err) {
    await rollback(client);
    logger.error('POST /api/harvests/:id/photos failed', err);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// DELETE /api/harvests/:id/photos?key=
router.delete('/:id/photos', ...photoGuards, async (req: Request, res: Response) => {
  const session = req.session as SessionData;
  const id = req.params.id as string;
  if (!isNumericId(id)) return res.status(400).json({ error: 'Invalid id' });

  const key = req.query.key;
  if (typeof key !== 'string' || key === '') {
    return res.status(400).json({ error: 'key is required' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const existing = await lockEntry(client, id, session);
    if (!existing) {
      await rollback(client);
      return res.status(404).json({ error: 'Harvest not found' });
    }
    if (!existing.photos.some((p) => p.key === key)) {
      await rollback(client);
      return res.status(404).json({ error: 'Photo not found' });
    }

    await client.query('UPDATE harvest_entries SET photos = $2::jsonb WHERE id = $1', [
      id,
      JSON.stringify(existing.photos.filter((p) => p.key !== key)),
    ]);

    const entry = await fetchEntry(client, id, session);
    await client.query('COMMIT');

    deletePhotoObject(key);
    return res.json(formatEntry(entry!));
  } catch (err) {
    await rollback(client);
    logger.error('DELETE /api/harvests/:id/photos failed', err);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

export default router;

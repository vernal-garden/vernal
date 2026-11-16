// Imports the Cambium N1 expansion (seeds/cambium-n1/seeds.csv and
// companions.csv) into the cambium schema.
//
//   npm run import:cambium-n1 -- [--dry-run]
//
// Every row is validated before the database is touched; any problem is
// printed and the script exits 1 without connecting. The import runs in one
// transaction (rolled back with --dry-run) and is safe to rerun: a second run
// reports zero changes.
//
// Only the written columns below are read from seeds.csv. The evidence
// columns (*_src, notes, review, the *_basis columns, sow_method,
// timing_class) are never read, so they never reach the database.
import '../src/loadEnv';
import fs from 'fs';
import path from 'path';
import { Pool, type PoolClient } from 'pg';
import { dbConnectionString, dbSslConfig } from '../src/lib/dbSsl';

export const DEFAULT_CSV_DIR = path.resolve(__dirname, '../seeds/cambium-n1');

type ColumnKind = 'text' | 'int' | 'numeric';

// The cambium.seeds columns this import writes, with their SQL kind.
export const WRITTEN_COLUMNS: ReadonlyArray<{ name: string; kind: ColumnKind }> = [
  { name: 'common_name', kind: 'text' },
  { name: 'scientific_name', kind: 'text' },
  { name: 'plant_family', kind: 'text' },
  { name: 'spacing_inches', kind: 'numeric' },
  { name: 'in_row_spacing_inches', kind: 'numeric' },
  { name: 'row_spacing_inches', kind: 'numeric' },
  { name: 'maturity_days_min', kind: 'int' },
  { name: 'maturity_days_max', kind: 'int' },
  { name: 'sunlight', kind: 'text' },
  { name: 'watering_needs', kind: 'text' },
  { name: 'hardiness_zone_min', kind: 'text' },
  { name: 'hardiness_zone_max', kind: 'text' },
  { name: 'frost_tolerance', kind: 'text' },
  { name: 'weeks_to_transplant', kind: 'int' },
  { name: 'succession_interval_weeks', kind: 'int' },
];

const SQL_TYPE: Record<ColumnKind, string> = { text: 'text', int: 'int', numeric: 'numeric' };

const SUNLIGHT = ['full_sun', 'partial_shade', 'full_shade'];
const WATERING = ['low', 'moderate', 'high'];
const FROST = ['none', 'light', 'hard', 'warm'];
const RELATIONSHIP = ['beneficial', 'antagonistic', 'neutral'];

const INTEGER_COLUMNS = [
  'maturity_days_min',
  'maturity_days_max',
  'weeks_to_transplant',
  'succession_interval_weeks',
];
const NUMBER_COLUMNS = ['spacing_inches', 'in_row_spacing_inches', 'row_spacing_inches'];
const ZONE_COLUMNS = ['hardiness_zone_min', 'hardiness_zone_max'];

const SEED_HEADER = ['common_name', 'existing_id', ...WRITTEN_COLUMNS.map((c) => c.name)];
const COMPANION_HEADER = ['seed', 'companion', 'relationship', 'confidence', 'source', 'notes'];

export interface SeedRow {
  rowNumber: number;
  existingId: number | null;
  /** Written column name -> cell value, '' already turned into null. */
  values: Record<string, string | null>;
}

export interface CompanionRow {
  rowNumber: number;
  seed: string;
  companion: string;
  relationship: string;
  confidence: number;
  source: string | null;
  notes: string | null;
}

export type ValidationResult =
  | { ok: true; seeds: SeedRow[]; companions: CompanionRow[] }
  | { ok: false; errors: string[] };

export type ValidData = Extract<ValidationResult, { ok: true }>;

export interface ImportCounts {
  seedsUpdated: number;
  seedsInserted: number;
  seedsUnchanged: number;
  personalCopyFieldsChanged: number;
  companionsInserted: number;
  companionsUpdated: number;
  companionsHeld: number;
}

// ── CSV ──────────────────────────────────────────────────────────────────────

/** RFC 4180 parser: quoted fields may hold commas, doubled quotes and line breaks; CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\r' || ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
    } else {
      field += ch;
    }
    i += 1;
  }
  if (quoted) throw new Error('Unterminated quoted field');
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // A trailing blank line is not a row.
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

// ── Validation ───────────────────────────────────────────────────────────────

function readTable(
  dir: string,
  file: string,
  required: string[],
  errors: string[],
): { header: string[]; rows: Array<{ rowNumber: number; get: (col: string) => string }> } | null {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, file), 'utf8');
  } catch (err) {
    errors.push(`${file}: cannot read (${err instanceof Error ? err.message : String(err)})`);
    return null;
  }
  let table: string[][];
  try {
    table = parseCsv(text);
  } catch (err) {
    errors.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  if (table.length === 0) {
    errors.push(`${file}: empty file`);
    return null;
  }
  const header = table[0].map((h) => h.trim());
  const missing = required.filter((c) => !header.includes(c));
  if (missing.length > 0) {
    errors.push(`${file} row 1: missing column(s) ${missing.join(', ')}`);
    return null;
  }
  const rows = [];
  for (let i = 1; i < table.length; i += 1) {
    const cells = table[i];
    const rowNumber = i + 1; // the header is row 1
    if (cells.length !== header.length) {
      errors.push(`${file} row ${rowNumber}: has ${cells.length} fields, header has ${header.length}`);
      continue;
    }
    rows.push({ rowNumber, get: (col: string) => cells[header.indexOf(col)].trim() });
  }
  return { header, rows };
}

const INTEGER_RE = /^\d+$/;
const NUMBER_RE = /^\d+(\.\d{1,2})?$/; // NUMERIC(6,2)

export function loadAndValidate(dir: string = DEFAULT_CSV_DIR): ValidationResult {
  const errors: string[] = [];
  const seedsTable = readTable(dir, 'seeds.csv', SEED_HEADER, errors);
  const compTable = readTable(dir, 'companions.csv', COMPANION_HEADER, errors);

  const seeds: SeedRow[] = [];
  const names = new Map<string, number>(); // common_name -> row number
  const existingIds = new Map<number, number>();

  for (const r of seedsTable?.rows ?? []) {
    const where = (col: string) => `seeds.csv row ${r.rowNumber}, column ${col}`;
    const values: Record<string, string | null> = {};
    for (const { name } of WRITTEN_COLUMNS) {
      const v = r.get(name);
      values[name] = v === '' ? null : v;
    }

    const name = values.common_name;
    if (name === null) {
      errors.push(`${where('common_name')}: required`);
    } else if (names.has(name)) {
      errors.push(`${where('common_name')}: "${name}" repeats row ${names.get(name)}`);
    } else {
      names.set(name, r.rowNumber);
    }

    let existingId: number | null = null;
    const idCell = r.get('existing_id');
    if (idCell !== '') {
      const n = Number(idCell);
      if (!INTEGER_RE.test(idCell) || n < 1 || n > 12) {
        errors.push(`${where('existing_id')}: "${idCell}" is not a starter id (1-12)`);
      } else if (existingIds.has(n)) {
        errors.push(`${where('existing_id')}: ${n} repeats row ${existingIds.get(n)}`);
      } else {
        existingIds.set(n, r.rowNumber);
        existingId = n;
      }
    }

    const oneOf = (col: string, allowed: string[]) => {
      const v = values[col];
      if (v !== null && !allowed.includes(v)) {
        errors.push(`${where(col)}: "${v}" is not one of ${allowed.join(', ')}`);
      }
    };
    oneOf('sunlight', SUNLIGHT);
    oneOf('watering_needs', WATERING);
    oneOf('frost_tolerance', FROST);

    for (const col of INTEGER_COLUMNS) {
      const v = values[col];
      if (v !== null && !INTEGER_RE.test(v)) errors.push(`${where(col)}: "${v}" is not a whole number`);
    }
    for (const col of NUMBER_COLUMNS) {
      const v = values[col];
      if (v !== null && (!NUMBER_RE.test(v) || Number(v) <= 0 || Number(v) >= 10000)) {
        errors.push(`${where(col)}: "${v}" is not a positive number with at most 2 decimals`);
      }
    }
    for (const col of ZONE_COLUMNS) {
      const v = values[col];
      if (v !== null && (!INTEGER_RE.test(v) || Number(v) < 1 || Number(v) > 13)) {
        errors.push(`${where(col)}: "${v}" is not a whole-number zone (1-13)`);
      }
    }
    const pairs: Array<[string, string]> = [
      ['maturity_days_min', 'maturity_days_max'],
      ['hardiness_zone_min', 'hardiness_zone_max'],
    ];
    for (const [lo, hi] of pairs) {
      const a = values[lo];
      const b = values[hi];
      if (a !== null && b !== null && INTEGER_RE.test(a) && INTEGER_RE.test(b) && Number(a) > Number(b)) {
        errors.push(`${where(lo)}: ${a} is greater than ${hi} ${b}`);
      }
    }

    seeds.push({ rowNumber: r.rowNumber, existingId, values });
  }

  const companions: CompanionRow[] = [];
  const pairsSeen = new Map<string, number>();
  for (const r of compTable?.rows ?? []) {
    const where = (col: string) => `companions.csv row ${r.rowNumber}, column ${col}`;
    const seed = r.get('seed');
    const companion = r.get('companion');
    let ok = true;
    for (const [col, v] of [['seed', seed], ['companion', companion]] as const) {
      if (!names.has(v)) {
        errors.push(`${where(col)}: "${v}" is not a common_name in seeds.csv`);
        ok = false;
      }
    }
    if (seed === companion && seed !== '') {
      errors.push(`${where('companion')}: "${seed}" is paired with itself`);
      ok = false;
    }
    const key = `${seed}\u0000${companion}`;
    if (pairsSeen.has(key)) {
      errors.push(`${where('companion')}: pair ${seed} -> ${companion} repeats row ${pairsSeen.get(key)}`);
      ok = false;
    } else {
      pairsSeen.set(key, r.rowNumber);
    }
    const relationship = r.get('relationship');
    if (!RELATIONSHIP.includes(relationship)) {
      errors.push(`${where('relationship')}: "${relationship}" is not one of ${RELATIONSHIP.join(', ')}`);
      ok = false;
    }
    const conf = r.get('confidence');
    if (!INTEGER_RE.test(conf) || Number(conf) > 100) {
      errors.push(`${where('confidence')}: "${conf}" is not a whole number from 0 to 100`);
      ok = false;
    }
    if (ok) {
      companions.push({
        rowNumber: r.rowNumber,
        seed,
        companion,
        relationship,
        confidence: Number(conf),
        source: r.get('source') === '' ? null : r.get('source'),
        notes: r.get('notes') === '' ? null : r.get('notes'),
      });
    }
  }

  if (errors.length > 0 || seedsTable === null || compTable === null) return { ok: false, errors };
  return { ok: true, seeds, companions };
}

// ── Import ───────────────────────────────────────────────────────────────────

function normalise(kind: ColumnKind, v: unknown): string | number | null {
  if (v === null || v === undefined) return null;
  return kind === 'text' ? String(v) : Number(v);
}

const COL_LIST = WRITTEN_COLUMNS.map((c) => c.name).join(', ');
const PARAMS = (offset: number) =>
  WRITTEN_COLUMNS.map((c, i) => `$${i + offset}::${SQL_TYPE[c.kind]}`).join(', ');

async function updateExisting(
  client: PoolClient,
  id: number,
  row: SeedRow,
  counts: ImportCounts,
): Promise<void> {
  const current = await client.query<Record<string, unknown>>(
    `SELECT ${COL_LIST} FROM cambium.seeds WHERE id = $1 FOR UPDATE`,
    [id],
  );
  if (current.rows.length === 0) {
    throw new Error(`seeds.csv row ${row.rowNumber}: cambium.seeds id ${id} does not exist`);
  }
  const old = current.rows[0];
  const changed = WRITTEN_COLUMNS.filter(
    (c) => normalise(c.kind, old[c.name]) !== normalise(c.kind, row.values[c.name]),
  );
  if (changed.length === 0) {
    counts.seedsUnchanged += 1;
    return;
  }

  const sets = WRITTEN_COLUMNS.map((c, i) => `${c.name} = $${i + 2}::${SQL_TYPE[c.kind]}`).join(', ');
  await client.query(`UPDATE cambium.seeds SET ${sets}, updated_at = NOW() WHERE id = $1`, [
    id,
    ...WRITTEN_COLUMNS.map((c) => row.values[c.name]),
  ]);
  counts.seedsUpdated += 1;

  // Personal copies follow a changed field only while they still hold the old
  // Cambium value; a field the gardener edited is left alone.
  for (const c of changed) {
    const t = SQL_TYPE[c.kind];
    const res = await client.query(
      `UPDATE seeds SET ${c.name} = $1::${t}, updated_at = NOW()
        WHERE cambium_source_id = $2
          AND ${c.name} IS NOT DISTINCT FROM $3::${t}
          AND ${c.name} IS DISTINCT FROM $1::${t}`,
      [row.values[c.name], id, old[c.name] ?? null],
    );
    counts.personalCopyFieldsChanged += res.rowCount ?? 0;
  }
}

export async function importCambiumN1(
  client: PoolClient,
  data: ValidData,
  options: { dryRun: boolean },
): Promise<ImportCounts> {
  const counts: ImportCounts = {
    seedsUpdated: 0,
    seedsInserted: 0,
    seedsUnchanged: 0,
    personalCopyFieldsChanged: 0,
    companionsInserted: 0,
    companionsUpdated: 0,
    companionsHeld: 0,
  };
  const idByName = new Map<string, number>();

  await client.query('BEGIN');
  try {
    // 1. Starter rows, by id.
    const claimedIds = new Set<number>();
    for (const row of data.seeds) {
      if (row.existingId === null) continue;
      await updateExisting(client, row.existingId, row, counts);
      idByName.set(row.values.common_name as string, row.existingId);
      claimedIds.add(row.existingId);
    }

    // 2. New rows: update an active row of the same name (a rerun), else insert.
    for (const row of data.seeds) {
      if (row.existingId !== null) continue;
      const name = row.values.common_name as string;
      const match = await client.query<{ id: number }>(
        `SELECT id FROM cambium.seeds
          WHERE common_name = $1 AND moderation_status = 'active' AND NOT (id = ANY($2::int[]))
          ORDER BY id LIMIT 1`,
        [name, [...claimedIds]],
      );
      if (match.rows.length > 0) {
        const id = match.rows[0].id;
        await updateExisting(client, id, row, counts);
        idByName.set(name, id);
        claimedIds.add(id);
        continue;
      }
      const inserted = await client.query<{ id: number }>(
        `INSERT INTO cambium.seeds (${COL_LIST}, source)
         VALUES (${PARAMS(1)}, 'editorial')
         RETURNING id`,
        WRITTEN_COLUMNS.map((c) => row.values[c.name]),
      );
      counts.seedsInserted += 1;
      idByName.set(name, inserted.rows[0].id);
      claimedIds.add(inserted.rows[0].id);
    }

    // 3. Companions: upsert the file's pairs, hold every other row.
    const seedIds: number[] = [];
    const companionIds: number[] = [];
    for (const c of data.companions) {
      const seedId = idByName.get(c.seed) as number;
      const companionId = idByName.get(c.companion) as number;
      seedIds.push(seedId);
      companionIds.push(companionId);
      const res = await client.query<{ inserted: boolean }>(
        `INSERT INTO cambium.companions AS c
           (seed_id, companion_seed_id, relationship, confidence, notes, source, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'active')
         ON CONFLICT (seed_id, companion_seed_id) DO UPDATE
           SET relationship = EXCLUDED.relationship,
               confidence   = EXCLUDED.confidence,
               notes        = EXCLUDED.notes,
               source       = EXCLUDED.source,
               status       = 'active'
           WHERE (c.relationship, c.confidence, c.notes, c.source, c.status)
                 IS DISTINCT FROM
                 (EXCLUDED.relationship, EXCLUDED.confidence, EXCLUDED.notes, EXCLUDED.source, 'active')
         RETURNING (xmax = 0) AS inserted`,
        [seedId, companionId, c.relationship, c.confidence, c.notes, c.source],
      );
      if (res.rows.length > 0) {
        if (res.rows[0].inserted) counts.companionsInserted += 1;
        else counts.companionsUpdated += 1;
      }
    }
    const held = await client.query(
      `UPDATE cambium.companions SET status = 'held'
        WHERE status <> 'held'
          AND (seed_id, companion_seed_id) NOT IN (
            SELECT * FROM unnest($1::int[], $2::int[])
          )`,
      [seedIds, companionIds],
    );
    counts.companionsHeld = held.rowCount ?? 0;

    await client.query(options.dryRun ? 'ROLLBACK' : 'COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
  return counts;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

export interface CliDeps {
  dir?: string;
  createPool?: () => Pool;
  log?: { log: (msg: string) => void; error: (msg: string) => void };
}

function defaultPool(): Pool {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not set');
  return new Pool({
    connectionString: dbConnectionString(process.env.DATABASE_URL),
    ssl: dbSslConfig(),
  });
}

export async function runCli(argv: string[], deps: CliDeps = {}): Promise<number> {
  const out = deps.log ?? console;
  const unknown = argv.filter((a) => a !== '--dry-run');
  if (unknown.length > 0) {
    out.error(`Unknown argument(s): ${unknown.join(' ')}. Usage: npm run import:cambium-n1 -- [--dry-run]`);
    return 1;
  }
  const dryRun = argv.includes('--dry-run');

  const data = loadAndValidate(deps.dir ?? DEFAULT_CSV_DIR);
  if (!data.ok) {
    out.error(`Validation failed (${data.errors.length} problem(s)); the database was not touched:`);
    for (const e of data.errors) out.error(`  ${e}`);
    return 1;
  }

  const pool = (deps.createPool ?? defaultPool)();
  try {
    const client = await pool.connect();
    let counts: ImportCounts;
    try {
      counts = await importCambiumN1(client, data, { dryRun });
    } finally {
      client.release();
    }
    out.log(`Seeds updated: ${counts.seedsUpdated}`);
    out.log(`Seeds inserted: ${counts.seedsInserted}`);
    out.log(`Seeds unchanged: ${counts.seedsUnchanged}`);
    out.log(`Personal-copy fields changed: ${counts.personalCopyFieldsChanged}`);
    out.log(`Companions inserted: ${counts.companionsInserted}`);
    out.log(`Companions updated: ${counts.companionsUpdated}`);
    out.log(`Companions held: ${counts.companionsHeld}`);
    out.log(dryRun ? 'Dry run: rolled back, nothing was saved.' : 'Committed.');
    return 0;
  } catch (err) {
    out.error(`Import failed and was rolled back: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  runCli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}

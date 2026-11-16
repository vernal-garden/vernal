import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import app from '../src/index';
import { refreshGardenBadges } from '../src/jobs/nightly';
import { currentSeason } from '../src/lib/season';
import { dbConnectionString, dbSslConfig } from '../src/lib/dbSsl';
import {
  DEFAULT_CSV_DIR,
  importCambiumN1,
  loadAndValidate,
  parseCsv,
  runCli,
  type ImportCounts,
} from './import-cambium-n1';

// TEST_DATABASE_URL is validated by src/test/setup.ts before this file runs.
const url = process.env.TEST_DATABASE_URL as string;

const pool = new Pool({ connectionString: dbConnectionString(url), ssl: dbSslConfig() });

const STARTER_SQL = fs.readFileSync(
  path.resolve(__dirname, '../seeds/cambium-starter.sql'),
  'utf8',
);

async function resetToStarter(): Promise<void> {
  await pool.query(
    `TRUNCATE accounts, guest_sessions, gardens, beds, plantings, seeds RESTART IDENTITY CASCADE`,
  );
  await pool.query('TRUNCATE cambium.companions, cambium.seeds RESTART IDENTITY CASCADE');
  await pool.query(STARTER_SQL);
}

// Other suites reseed the starter set by name and expect the starter ids, so
// leave the catalogue the way they expect it.
afterAll(async () => {
  try {
    await resetToStarter();
  } finally {
    await pool.end();
  }
});

async function snapshot(): Promise<string> {
  const seeds = await pool.query('SELECT * FROM cambium.seeds ORDER BY id');
  const companions = await pool.query('SELECT * FROM cambium.companions ORDER BY id');
  const personal = await pool.query('SELECT * FROM seeds ORDER BY id');
  return JSON.stringify([seeds.rows, companions.rows, personal.rows]);
}

async function runImport(dryRun: boolean): Promise<ImportCounts> {
  const data = loadAndValidate(DEFAULT_CSV_DIR);
  if (!data.ok) throw new Error(data.errors.join('\n'));
  const client = await pool.connect();
  try {
    return await importCambiumN1(client, data, { dryRun });
  } finally {
    client.release();
  }
}

function readCsv(file: string): string[][] {
  return parseCsv(fs.readFileSync(path.join(DEFAULT_CSV_DIR, file), 'utf8'));
}

// Copies the real CSVs into a temp dir and sets one cell.
function fixtureWith(
  file: 'seeds.csv' | 'companions.csv',
  match: (row: string[], header: string[]) => boolean,
  column: string,
  value: string,
): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cambium-n1-'));
  fs.copyFileSync(path.join(DEFAULT_CSV_DIR, 'seeds.csv'), path.join(dir, 'seeds.csv'));
  fs.copyFileSync(path.join(DEFAULT_CSV_DIR, 'companions.csv'), path.join(dir, 'companions.csv'));
  const rows = readCsv(file);
  const header = rows[0];
  const col = header.indexOf(column);
  if (col < 0) throw new Error(`no column ${column}`);
  const target = rows.findIndex((r, i) => i > 0 && match(r, header));
  if (target < 0) throw new Error('no matching row');
  rows[target][col] = value;
  const quote = (cell: string) => (/[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell);
  fs.writeFileSync(path.join(dir, file), rows.map((r) => r.map(quote).join(',')).join('\r\n') + '\r\n');
  return dir;
}

const byName = (name: string) => (row: string[], header: string[]) =>
  row[header.indexOf('common_name')] === name;

describe('import-cambium-n1 validation', () => {
  beforeEach(resetToStarter);

  const cases: Array<{
    name: string;
    dir: () => string;
    expected: RegExp;
  }> = [
    {
      name: 'a bad sunlight enum',
      dir: () => fixtureWith('seeds.csv', byName('Basil'), 'sunlight', 'blazing'),
      expected: /seeds\.csv row \d+, column sunlight/,
    },
    {
      name: 'a non-integer maturity_days_min',
      dir: () => fixtureWith('seeds.csv', byName('Basil'), 'maturity_days_min', '14.5'),
      expected: /seeds\.csv row \d+, column maturity_days_min/,
    },
    {
      name: 'an unknown companion name',
      dir: () => fixtureWith('companions.csv', () => true, 'companion', 'Moonflower'),
      expected: /companions\.csv row 2, column companion/,
    },
    {
      name: 'an existing_id of 13',
      dir: () => fixtureWith('seeds.csv', byName('Pole Bean'), 'existing_id', '13'),
      expected: /seeds\.csv row \d+, column existing_id/,
    },
  ];

  for (const c of cases) {
    it(`rejects ${c.name}, prints the problem, and never connects`, async () => {
      const dir = c.dir();
      const before = await snapshot();
      const createPool = vi.fn(() => new Pool({ connectionString: dbConnectionString(url) }));
      const errors: string[] = [];
      const log = { log: vi.fn(), error: (msg: string) => errors.push(msg) };

      const code = await runCli([], { dir, createPool, log });

      expect(code).toBe(1);
      expect(createPool).not.toHaveBeenCalled();
      expect(errors.join('\n')).toMatch(c.expected);
      expect(await snapshot()).toBe(before);
    });
  }

  it('accepts the committed CSVs', () => {
    const data = loadAndValidate(DEFAULT_CSV_DIR);
    expect(data.ok ? [] : data.errors).toEqual([]);
    if (!data.ok) return;
    expect(data.seeds).toHaveLength(78);
    expect(data.companions).toHaveLength(72);
  });
});

describe('import-cambium-n1 real run', () => {
  beforeEach(resetToStarter);

  it('leaves 78 active editorial seeds with ids 1-12 kept and renamed from the CSV', async () => {
    const counts = await runImport(false);
    expect(counts.seedsUpdated).toBe(12);
    expect(counts.seedsInserted).toBe(66);
    expect(counts.seedsUnchanged).toBe(0);

    const { rows } = await pool.query<{ id: number; common_name: string }>(
      `SELECT id, common_name FROM cambium.seeds
        WHERE moderation_status = 'active' AND source = 'editorial' ORDER BY id`,
    );
    expect(rows).toHaveLength(78);
    const total = await pool.query('SELECT COUNT(*)::int AS n FROM cambium.seeds');
    expect(total.rows[0].n).toBe(78);

    const names = new Map(rows.map((r) => [r.id, r.common_name]));
    expect(names.get(10)).toBe('Bush Bean');
    expect(names.get(11)).toBe('Leaf Lettuce');

    const csv = readCsv('seeds.csv');
    const h = csv[0];
    const withIds = csv
      .slice(1)
      .filter((r) => r[h.indexOf('existing_id')] !== '')
      .map((r) => [Number(r[h.indexOf('existing_id')]), r[h.indexOf('common_name')]] as const);
    expect(withIds).toHaveLength(12);
    for (const [id, name] of withIds) expect(names.get(id)).toBe(name);
  });

  it('stores no evidence: no evidence columns, no source/notes text in seeds, companion notes from companions.csv', async () => {
    await runImport(false);

    const cols = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'cambium'
          AND (column_name ILIKE '%evidence%' OR column_name ILIKE '%\\_src' ESCAPE '\\')`,
    );
    expect(cols.rows).toEqual([]);

    const csv = readCsv('seeds.csv');
    const h = csv[0];
    const evidenceCols = h
      .map((name, i) => [name, i] as const)
      .filter(([name]) => name.endsWith('_src') || name === 'notes' || name === 'review');
    const evidence = new Set<string>();
    for (const r of csv.slice(1)) {
      for (const [, i] of evidenceCols) if (r[i].trim() !== '') evidence.add(r[i].trim());
    }
    expect(evidence.size).toBeGreaterThan(0);

    const { rows } = await pool.query<{ j: Record<string, unknown> }>(
      'SELECT row_to_json(s) AS j FROM cambium.seeds s',
    );
    for (const { j } of rows) {
      for (const value of Object.values(j)) {
        if (typeof value === 'string') expect(evidence.has(value)).toBe(false);
      }
    }

    const comp = readCsv('companions.csv');
    const ch = comp[0];
    const expected = comp
      .slice(1)
      .map((r) => ({
        seed: r[ch.indexOf('seed')],
        companion: r[ch.indexOf('companion')],
        notes: r[ch.indexOf('notes')] === '' ? null : r[ch.indexOf('notes')],
        source: r[ch.indexOf('source')] === '' ? null : r[ch.indexOf('source')],
      }))
      .sort((a, b) => (a.seed + '|' + a.companion).localeCompare(b.seed + '|' + b.companion));
    const stored = await pool.query<{ seed: string; companion: string; notes: string | null; source: string | null }>(
      `SELECT s1.common_name AS seed, s2.common_name AS companion, c.notes, c.source
         FROM cambium.companions c
         JOIN cambium.seeds s1 ON s1.id = c.seed_id
         JOIN cambium.seeds s2 ON s2.id = c.companion_seed_id
        WHERE c.status = 'active'`,
    );
    const actual = [...stored.rows].sort((a, b) =>
      (a.seed + '|' + a.companion).localeCompare(b.seed + '|' + b.companion),
    );
    expect(actual).toEqual(expected);
  });

  it('updates personal copies only where they still hold the old Cambium value', async () => {
    const account = await pool.query<{ id: number }>(
      `INSERT INTO accounts (email, zone, zone_location_label)
       VALUES ('n1-import@example.com', '7b', 'Test City') RETURNING id`,
    );
    const ownerId = account.rows[0].id;
    const copy = async (spacing: number): Promise<number> => {
      const { rows } = await pool.query<{ id: number }>(
        `INSERT INTO seeds (owner_id, common_name, scientific_name, plant_family, cambium_source_id, origin,
                            spacing_inches, maturity_days_min, maturity_days_max, sunlight, watering_needs,
                            hardiness_zone_min, hardiness_zone_max, frost_tolerance, weeks_to_transplant,
                            succession_interval_weeks)
         SELECT $1, common_name, scientific_name, plant_family, id, 'cambium_imported',
                $2, maturity_days_min, maturity_days_max, sunlight, watering_needs,
                hardiness_zone_min, hardiness_zone_max, frost_tolerance, weeks_to_transplant,
                succession_interval_weeks
           FROM cambium.seeds WHERE id = 12
         RETURNING id`,
        [ownerId, spacing],
      );
      return rows[0].id;
    };
    const untouched = await copy(12); // the starter value
    const changed = await copy(9);

    const counts = await runImport(false);
    expect(counts.personalCopyFieldsChanged).toBeGreaterThan(0);

    const cambium = await pool.query('SELECT * FROM cambium.seeds WHERE id = 12');
    const basil = cambium.rows[0];
    expect(basil.hardiness_zone_min).toBeNull();
    expect(basil.hardiness_zone_max).toBeNull();
    expect(Number(basil.spacing_inches)).toBe(6);

    const { rows } = await pool.query(
      'SELECT id, spacing_inches, hardiness_zone_min, hardiness_zone_max, maturity_days_min FROM seeds ORDER BY id',
    );
    const u = rows.find((r) => r.id === untouched);
    const c = rows.find((r) => r.id === changed);
    expect(u.hardiness_zone_min).toBeNull();
    expect(u.hardiness_zone_max).toBeNull();
    expect(Number(u.spacing_inches)).toBe(6);
    expect(u.maturity_days_min).toBe(basil.maturity_days_min);
    expect(c.hardiness_zone_min).toBeNull();
    expect(c.hardiness_zone_max).toBeNull();
    expect(Number(c.spacing_inches)).toBe(9);
  });

  it('makes the 72 file pairs active and holds the starter pairs not in the file, hiding them from the API and the nightly badge', async () => {
    const counts = await runImport(false);

    const active = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM cambium.companions WHERE status = 'active'`,
    );
    expect(active.rows[0].n).toBe(72);
    const held = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM cambium.companions WHERE status = 'held'`,
    );
    expect(held.rows[0].n).toBe(counts.companionsHeld);
    expect(counts.companionsHeld).toBeGreaterThan(0);
    expect(counts.companionsInserted + counts.companionsUpdated).toBeLessThanOrEqual(72);
    // Every held row is a starter row (ids 1-12) that the file does not list.
    const heldRows = await pool.query<{ seed_id: number; companion_seed_id: number }>(
      `SELECT seed_id, companion_seed_id FROM cambium.companions WHERE status = 'held'`,
    );
    for (const r of heldRows.rows) {
      expect(r.seed_id).toBeLessThanOrEqual(12);
      expect(r.companion_seed_id).toBeLessThanOrEqual(12);
    }

    // A held antagonistic pair with no active row in either direction.
    const pair = await pool.query<{ seed_id: number; companion_seed_id: number }>(
      `SELECT h.seed_id, h.companion_seed_id
         FROM cambium.companions h
        WHERE h.status = 'held' AND h.relationship = 'antagonistic' AND h.confidence >= 40
          AND NOT EXISTS (
            SELECT 1 FROM cambium.companions a
             WHERE a.status = 'active'
               AND ((a.seed_id = h.seed_id AND a.companion_seed_id = h.companion_seed_id)
                 OR (a.seed_id = h.companion_seed_id AND a.companion_seed_id = h.seed_id)))
        ORDER BY h.id LIMIT 1`,
    );
    expect(pair.rows).toHaveLength(1);
    const { seed_id: a, companion_seed_id: b } = pair.rows[0];

    const res = await request(app).get(`/api/catalogue/seeds/${a}/companions`);
    expect(res.status).toBe(200);
    const ids = (res.body.data as Array<{ seed: { id: string } }>).map((e) => Number(e.seed.id));
    expect(ids).not.toContain(b);
    const back = await request(app).get(`/api/catalogue/seeds/${b}/companions`);
    expect(back.status).toBe(200);
    expect((back.body.data as Array<{ seed: { id: string } }>).map((e) => Number(e.seed.id))).not.toContain(a);

    // Control: an active antagonistic pair from the file.
    const activePair = await pool.query<{ seed_id: number; companion_seed_id: number }>(
      `SELECT seed_id, companion_seed_id FROM cambium.companions
        WHERE status = 'active' AND relationship = 'antagonistic' AND confidence >= 40
        ORDER BY id LIMIT 1`,
    );
    expect(activePair.rows).toHaveLength(1);

    const account = await pool.query<{ id: number }>(
      `INSERT INTO accounts (email, zone, zone_location_label)
       VALUES ('n1-badge@example.com', '7b', 'Test City') RETURNING id`,
    );
    const season = currentSeason();
    const gardenWith = async (first: number, second: number): Promise<number> => {
      const g = await pool.query<{ id: number }>(
        `INSERT INTO gardens (owner_id, name, style, zone) VALUES ($1, 'N1', 'grid', '7b') RETURNING id`,
        [account.rows[0].id],
      );
      const gardenId = g.rows[0].id;
      const bed = await pool.query<{ id: number }>(
        `INSERT INTO beds (garden_id, season, type, grid_x, grid_y, grid_cols, grid_rows)
         VALUES ($1, $2, 'grid', 0, 0, 4, 4) RETURNING id`,
        [gardenId, season],
      );
      let x = 0;
      for (const seedId of [first, second]) {
        await pool.query(
          `INSERT INTO plantings (bed_id, garden_id, season, cambium_seed_id, cell_x, cell_y)
           VALUES ($1, $2, $3, $4, $5, 0)`,
          [bed.rows[0].id, gardenId, season, seedId, x++],
        );
      }
      return gardenId;
    };
    const gardenHeld = await gardenWith(a, b);
    const gardenActive = await gardenWith(activePair.rows[0].seed_id, activePair.rows[0].companion_seed_id);

    await refreshGardenBadges();

    const badges = await pool.query<{ id: number; has_companion_warnings: boolean }>(
      'SELECT id, has_companion_warnings FROM gardens WHERE id = ANY($1::int[])',
      [[gardenHeld, gardenActive]],
    );
    const byId = Object.fromEntries(badges.rows.map((r) => [r.id, r.has_companion_warnings]));
    expect(byId[gardenHeld]).toBe(false);
    expect(byId[gardenActive]).toBe(true);
  });

  it('reports zero changes on a second real run', async () => {
    await runImport(false);
    const second = await runImport(false);
    expect(second).toEqual({
      seedsUpdated: 0,
      seedsInserted: 0,
      seedsUnchanged: 78,
      personalCopyFieldsChanged: 0,
      companionsInserted: 0,
      companionsUpdated: 0,
      companionsHeld: 0,
    });
  });

  it('dry run leaves a fresh starter database unchanged and reports what a real run would do', async () => {
    const before = await snapshot();
    const dry = await runImport(true);
    expect(await snapshot()).toBe(before);

    const real = await runImport(false);
    expect(dry).toEqual(real);
    expect(dry.seedsInserted).toBe(66);
  });

  it('CLI --dry-run prints the counts and rolls back', async () => {
    const before = await snapshot();
    const out: string[] = [];
    const createPool = vi.fn(() => new Pool({ connectionString: dbConnectionString(url), ssl: dbSslConfig() }));
    const code = await runCli(['--dry-run'], {
      createPool,
      log: { log: (m: string) => out.push(m), error: (m: string) => out.push(m) },
    });
    expect(code).toBe(0);
    expect(createPool).toHaveBeenCalledTimes(1);
    expect(out.join('\n')).toMatch(/Seeds inserted: 66/);
    expect(out.join('\n')).toMatch(/Dry run: rolled back/);
    expect(await snapshot()).toBe(before);
  });
});

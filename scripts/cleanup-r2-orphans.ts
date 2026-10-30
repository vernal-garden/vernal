import dotenv from 'dotenv';
import { Pool } from 'pg';
import { ConfigError, loadServerConfig } from '../src/lib/serverConfig';
import { storage, type Area } from '../src/lib/storage';

dotenv.config();

try {
  loadServerConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

// One-off: deletes storage folders whose seed, harvest, garden or account no longer
// exists, export ZIPs with no export row behind them, and any exports/ folder
// in the media area (the public bucket on S3) — files orphaned by deletes made before the cleanup
// queue. Dry run by default; pass --apply to delete. Safe to re-run.

const apply = process.argv.includes('--apply');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL must be set');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

type OwnerTable = 'seeds' | 'harvest_entries' | 'gardens' | 'accounts';

// The ids from this list that still exist in the table. bigint so an id past
// the int4 range is simply not found, rather than failing the whole query.
async function existingIds(table: OwnerTable, ids: number[]): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const { rows } = await pool.query<{ id: number }>(
    `SELECT id FROM ${table} WHERE id = ANY($1::bigint[])`,
    [ids],
  );
  return new Set(rows.map((r) => Number(r.id)));
}

// 'seed-photos/12/' → 12; anything else → null.
function folderId(folder: string): number | null {
  const m = /^[a-z-]+\/(\d+)\/$/.exec(folder);
  return m ? Number(m[1]) : null;
}

// Lists the folders under root with their ids, printing and dropping any
// folder without a numeric id or with one too large to compare exactly.
async function parseFolders(area: Area, root: string): Promise<Array<{ folder: string; id: number }>> {
  const parsed: Array<{ folder: string; id: number }> = [];
  for (const folder of await storage().listFolders(area, root)) {
    const id = folderId(folder);
    if (id === null) console.log(`skip ${folder} (no numeric id)`);
    else if (!Number.isSafeInteger(id)) console.log(`skip ${folder} (id too large)`);
    else parsed.push({ folder, id });
  }
  return parsed;
}

let total = 0;

async function sweepFolders(root: string, table: Exclude<OwnerTable, 'accounts'>): Promise<void> {
  const parsed = await parseFolders('media', root);
  const live = await existingIds(table, parsed.map((p) => p.id));
  for (const { folder, id } of parsed) {
    if (live.has(id)) continue;
    total += 1;
    console.log(`orphan folder ${folder}`);
    if (apply) await storage().removePrefix('media', folder);
  }
}

async function sweepExports(): Promise<void> {
  const parsed = await parseFolders('exports', 'exports/');
  const live = await existingIds('accounts', parsed.map((p) => p.id));
  // Any key with an export row is live, whatever its status or expiry: the
  // nightly purgeExpiredExports owns those rows and their ZIPs.
  const { rows: jobs } = await pool.query<{ id: number; account_id: number }>(
    'SELECT id, account_id FROM data_export_jobs',
  );
  const liveKeys = new Set(jobs.map((j) => `exports/${j.account_id}/${j.id}.zip`));

  for (const { folder, id } of parsed) {
    if (!live.has(id)) {
      total += 1;
      console.log(`orphan export folder ${folder}`);
      if (apply) await storage().removePrefix('exports', folder);
    } else {
      for (const key of await storage().listKeys('exports', folder)) {
        if (liveKeys.has(key)) continue;
        total += 1;
        console.log(`stale export ${key}`);
        if (apply) await storage().remove('exports', key);
      }
    }
  }
}

// Exports belong only in the exports area, so every exports/ folder in the
// media area is an orphan.
async function sweepPublicExports(): Promise<void> {
  for (const folder of await storage().listFolders('media', 'exports/')) {
    total += 1;
    console.log(`public export folder ${folder}`);
    if (apply) await storage().removePrefix('media', folder);
  }
}

async function main(): Promise<void> {
  await sweepFolders('seed-photos/', 'seeds');
  await sweepFolders('harvest-photos/', 'harvest_entries');
  await sweepFolders('garden-thumbnails/', 'gardens');
  await sweepExports();
  await sweepPublicExports();
  console.log(`${total} orphan(s)${apply ? ' deleted' : '; re-run with --apply to delete'}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

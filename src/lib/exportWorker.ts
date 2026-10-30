import { once } from 'events';
import { PassThrough, Readable } from 'stream';
import { ZipArchive } from 'archiver';
import Cursor from 'pg-cursor';
import { types as pgTypes, CustomTypesConfig, PoolClient } from 'pg';
import { jobDb as db } from './db'; // long-running work: job pool, 5-min statement cap
import { logger } from './logger';
import { storage } from './storage';
import { exportFolder } from './storage/keys';
import { exportPhotoPath } from './media';

export function exportKey(accountId: number, jobId: number): string {
  return `${exportFolder(accountId)}${jobId}.zip`;
}

// Export-only type parsing: DATE stays a plain 'YYYY-MM-DD' string (the
// default parser builds a local-midnight Date that shifts across time zones)
// and NUMERIC becomes a number instead of a string.
const DATE_OID = 1082;
const NUMERIC_OID = 1700;
const exportTypes: CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: 'text' | 'binary') => {
    if (oid === DATE_OID) return (value: string) => value;
    if (oid === NUMERIC_OID) return (value: string) => Number(value);
    return format === 'binary' ? pgTypes.getTypeParser(oid, 'binary') : pgTypes.getTypeParser(oid);
  }) as CustomTypesConfig['getTypeParser'],
};

type Row = Record<string, unknown>;

// Rows fetched per cursor read; bounds memory per streamed file.
const CURSOR_BATCH = 500;

async function query(client: PoolClient, text: string, accountId: number): Promise<Row[]> {
  const { rows } = await client.query<Row>({ text, values: [accountId], types: exportTypes });
  return rows;
}

// Timestamps serialised by Postgres inside JSONB (e.g. "2026-10-09T12:00:00.123+00:00").
const PG_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{2}(:\d{2})?$/;

function toCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

// Camel-cases a row's column names and renders its timestamps as ISO strings.
// Only top-level columns are touched — JSONB values (preferences, photos,
// freeform_points) are the user's own data and are exported as stored.
function formatRow(row: Row): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(row)) {
    let v = value;
    if (v instanceof Date) v = v.toISOString();
    else if (typeof v === 'string' && PG_TIMESTAMP_RE.test(v)) v = new Date(v).toISOString();
    out[toCamel(key)] = v;
  }
  return out;
}

const ACCOUNT_GARDENS = 'SELECT id FROM gardens WHERE owner_id = $1';

const COMMON_NAME_JOINS = `
  LEFT JOIN seeds s ON s.id = t.seed_id
  LEFT JOIN cambium.seeds cs ON cs.id = t.cambium_seed_id`;

// A photo's path inside the ZIP, or null if it was not included.
function photoFile(key: string | undefined, missing: ReadonlySet<string>): string | null {
  if (!key || missing.has(key)) return null;
  return exportPhotoPath(key);
}

// Every photo the account owns, read in the snapshot before anything is
// appended. Harvest photos stored without a key (legacy URL strings) are skipped.
const PHOTO_KEYS = `
  SELECT sp.r2_key AS key FROM seed_photos sp
    JOIN seeds s ON s.id = sp.seed_id
   WHERE s.owner_id = $1
  UNION ALL
  SELECT p->>'key' FROM harvest_entries h
    JOIN gardens g ON g.id = h.garden_id
    CROSS JOIN LATERAL jsonb_array_elements(h.photos) p
   WHERE g.owner_id = $1 AND p->>'key' IS NOT NULL`;

type RowTransform = (row: Row, missing: ReadonlySet<string>) => Row;

// Files that are a JSON array of rows, streamed from a cursor. Each query
// takes the account id as $1. A transform, if any, rewrites each raw row
// before formatting.
const STREAMED_FILES: { name: string; text: string; transform?: RowTransform }[] = [
  {
    name: 'plantings.json',
    text: `SELECT t.*, COALESCE(s.common_name, cs.common_name) AS common_name
           FROM plantings t ${COMMON_NAME_JOINS}
           WHERE t.garden_id IN (${ACCOUNT_GARDENS})
           ORDER BY t.id`,
  },
  { name: 'personal_seeds.json', text: 'SELECT * FROM seeds WHERE owner_id = $1 ORDER BY id' },
  {
    name: 'seed_photos.json',
    text: `SELECT sp.id, sp.seed_id, sp.r2_key, sp.taken_at, sp.notes, sp.created_at
           FROM seed_photos sp
           JOIN seeds s ON s.id = sp.seed_id
           WHERE s.owner_id = $1
           ORDER BY sp.id`,
    // The photo's file in this ZIP replaces its storage key.
    transform: ({ r2_key, ...row }, missing) => ({
      ...row,
      file: photoFile(r2_key as string, missing),
    }),
  },
  // harvest_entries has no bed_id column, so no bed label is exported.
  {
    name: 'harvest_entries.json',
    text: `SELECT t.*, COALESCE(s.common_name, cs.common_name) AS common_name,
                  g.name AS garden_name
           FROM harvest_entries t
           JOIN gardens g ON g.id = t.garden_id ${COMMON_NAME_JOINS}
           WHERE g.owner_id = $1
           ORDER BY t.id`,
    // Each photo's file in this ZIP replaces its storage key and URL.
    transform: (row, missing) => ({
      ...row,
      photos: (row.photos as unknown[]).map((p) => ({
        file: photoFile((p as { key?: string } | null)?.key, missing),
      })),
    }),
  },
  {
    name: 'sowing_events.json',
    text: `SELECT t.*, COALESCE(s.common_name, cs.common_name) AS common_name
           FROM sowing_events t ${COMMON_NAME_JOINS}
           WHERE t.garden_id IN (${ACCOUNT_GARDENS})
           ORDER BY t.id`,
  },
  {
    name: 'seed_preferences.json',
    text: 'SELECT * FROM user_seed_preferences WHERE account_id = $1 ORDER BY id',
  },
  {
    name: 'soil_readings.json',
    text: `SELECT * FROM soil_readings WHERE garden_id IN (${ACCOUNT_GARDENS}) ORDER BY id`,
  },
  {
    name: 'amendment_logs.json',
    text: `SELECT al.*,
                  COALESCE(
                    array_agg(alb.bed_id ORDER BY alb.bed_id) FILTER (WHERE alb.bed_id IS NOT NULL),
                    '{}'::int[]
                  ) AS bed_ids
           FROM amendment_logs al
           LEFT JOIN amendment_log_beds alb ON alb.amendment_log_id = al.id
           WHERE al.garden_id IN (${ACCOUNT_GARDENS})
           GROUP BY al.id
           ORDER BY al.id`,
  },
  // credentials is deliberately never selected.
  {
    name: 'weather_connections.json',
    text: `SELECT id, provider, station_id, is_primary, last_successful_sync, created_at
           FROM weather_connections WHERE account_id = $1 ORDER BY id`,
  },
  {
    name: 'usage_events.json',
    text: 'SELECT event_key, created_at FROM usage_events WHERE user_id = $1 ORDER BY created_at, id',
  },
  // Tokens (access/refresh, encrypted) are deliberately never selected.
  {
    name: 'oauth_identities.json',
    text: `SELECT provider, provider_user_id, provider_email, created_at
           FROM oauth_identities WHERE account_id = $1 ORDER BY id`,
  },
  {
    name: 'notifications.json',
    text: `SELECT id, type, payload, read_at, created_at
           FROM notifications WHERE account_id = $1 ORDER BY id`,
  },
  // resolution_note is the moderator's, not the user's, and is never exported.
  {
    name: 'contributions.json',
    text: `SELECT id, type, seed_id, cambium_seed_id, content, status, created_at, resolved_at
           FROM moderation_items WHERE submitted_by = $1 ORDER BY id`,
  },
  {
    name: 'seed_ratings.json',
    text: `SELECT r.seed_id, cs.common_name, r.rating, r.created_at
           FROM cambium.seed_ratings r
           LEFT JOIN cambium.seeds cs ON cs.id = r.seed_id
           WHERE r.account_id = $1
           ORDER BY r.id`,
  },
  {
    name: 'weather_readings.json',
    text: `SELECT wr.connection_id, wc.provider, wr.reading_timestamp, wr.temperature, wr.humidity,
                  wr.wind_speed, wr.wind_direction, wr.precipitation_today, wr.uv_index, wr.pressure
           FROM weather_readings wr
           JOIN weather_connections wc ON wc.id = wr.connection_id
           WHERE wc.account_id = $1
           ORDER BY wr.connection_id, wr.reading_timestamp, wr.id`,
  },
];

// Small files, read in full before any cursor opens.
async function collectSmallFiles(client: PoolClient, accountId: number): Promise<Record<string, unknown>> {
  const accountRows = await query(
    client,
    `SELECT to_jsonb(a) - 'password_hash' - 'stripe_customer_id' - 'stripe_subscription_id'
       AS account
     FROM accounts a WHERE a.id = $1`,
    accountId,
  );
  const gardens = await query(client, 'SELECT * FROM gardens WHERE owner_id = $1 ORDER BY id', accountId);
  const beds = await query(
    client,
    `SELECT * FROM beds WHERE garden_id IN (${ACCOUNT_GARDENS}) ORDER BY id`,
    accountId,
  );
  const feedbackSubmissions = await query(
    client,
    'SELECT * FROM feedback_submissions WHERE user_id = $1 ORDER BY id',
    accountId,
  );
  const microFeedback = await query(
    client,
    'SELECT * FROM micro_feedback_responses WHERE account_id = $1 ORDER BY id',
    accountId,
  );

  const bedsByGarden = new Map<unknown, Row[]>();
  for (const bed of beds) {
    const list = bedsByGarden.get(bed.garden_id) ?? [];
    list.push(formatRow(bed));
    bedsByGarden.set(bed.garden_id, list);
  }

  const accountJson = accountRows[0]?.account as Row | undefined;

  // The thumbnail is a storage reference to a file the export does not include.
  const gardenRow = (g: Row): Row => {
    const row = { ...g };
    delete row.thumbnail_url;
    return formatRow(row);
  };

  return {
    'account.json': accountJson ? formatRow(accountJson) : null,
    'gardens.json': gardens.map((g) => ({ ...gardenRow(g), beds: bedsByGarden.get(g.id) ?? [] })),
    'feedback.json': {
      submissions: feedbackSubmissions.map(formatRow),
      microFeedback: microFeedback.map(formatRow),
    },
  };
}

// One file's rows as a JSON array, formatted exactly like
// JSON.stringify(rows, null, 2). Lazy: the cursor opens on the first read and
// is closed when the array ends or the stream is destroyed.
async function* jsonArrayFromCursor(
  client: PoolClient,
  text: string,
  accountId: number,
  transform: RowTransform | undefined,
  missing: ReadonlySet<string>,
): AsyncGenerator<string> {
  const cursor = client.query(new Cursor<Row>(text, [accountId], { types: exportTypes }));
  try {
    let count = 0;
    yield '[';
    for (;;) {
      const rows = await cursor.read(CURSOR_BATCH);
      if (rows.length === 0) break;
      let chunk = '';
      for (const row of rows) {
        const element = JSON.stringify(formatRow(transform ? transform(row, missing) : row), null, 2).replace(/\n/g, '\n  ');
        chunk += `${count === 0 ? '\n' : ',\n'}  ${element}`;
        count++;
      }
      yield chunk;
    }
    yield count === 0 ? ']' : '\n]';
  } finally {
    await cursor.close();
  }
}

const README_FILES: [string, string][] = [
  ['photos/', 'your seed and harvest photos'],
  ['account.json', 'your account and settings'],
  ['gardens.json', 'your gardens, each with its beds'],
  ['plantings.json', 'what is planted in your gardens'],
  ['personal_seeds.json', 'the seeds in your library'],
  ['seed_photos.json', 'photos of your seeds'],
  ['harvest_entries.json', 'harvests you logged'],
  ['sowing_events.json', 'sowings you logged'],
  ['seed_preferences.json', 'your custom dates and settings for each seed'],
  ['soil_readings.json', 'your soil tests'],
  ['amendment_logs.json', 'soil amendments you applied'],
  ['weather_connections.json', 'your weather stations (without their credentials)'],
  ['weather_readings.json', 'readings from your weather stations'],
  ['oauth_identities.json', 'accounts you sign in with, such as Google'],
  ['notifications.json', 'notifications Vernal sent you'],
  ['contributions.json', 'corrections and seeds you submitted to the community seed database'],
  ['seed_ratings.json', 'your ratings of community seeds'],
  ['feedback.json', 'feedback you sent'],
  ['usage_events.json', 'which features you used, and when'],
];

function readme(): string {
  const exportedOn = new Date().toLocaleDateString('en-US', {
    timeZone: 'America/Los_Angeles',
    dateStyle: 'long',
  });
  const list = README_FILES.map(([name, what]) => `${name} - ${what}`).join('\n');
  return (
    `Your Vernal data, exported ${exportedOn}. Photos are in the photos folder; ` +
    `seed_photos.json and harvest_entries.json give each one's file.\n\n${list}\n`
  );
}

// Streams the whole archive into storage. Entries are appended one at a time, the
// next only after archiver has read the previous one to the end, so the
// single client never has more than one cursor open.
async function streamExport(
  client: PoolClient,
  accountId: number,
  key: string,
): Promise<void> {
  const small = await collectSmallFiles(client, accountId);

  const archive = new ZipArchive({ zlib: { level: 9 } });
  const output = new PassThrough();

  // Settles on the first failure from the archive, the upload or an entry's
  // source; every step below races it so nothing waits on a dead stream.
  let fail!: (err: unknown) => void;
  const failure = new Promise<never>((_, reject) => {
    fail = reject;
  });
  failure.catch(() => undefined);
  const step = <T>(p: Promise<T>): Promise<T> => Promise.race([p, failure]);

  archive.on('error', fail);
  // Without a listener, the output.destroy(err) below would surface as an
  // uncaught exception whenever the upload has stopped reading the stream.
  output.on('error', fail);
  archive.pipe(output);
  const uploaded = storage().putStream('exports', key, output, 'application/zip');
  uploaded.catch(fail);

  let source: Readable | null = null;
  const append = async (name: string, data: string | Readable, opts: { store?: boolean } = {}) => {
    const entered = once(archive, 'entry');
    archive.append(data, { name, ...opts });
    await step(entered);
  };

  try {
    // Photos first, so the JSON written after them can mark any missing file.
    const missing = new Set<string>();
    const photoKeys = (await query(client, PHOTO_KEYS, accountId)).map((r) => r.key as string);
    for (const key of photoKeys) {
      const name = exportPhotoPath(key);
      if (!name) {
        logger.warn('Export skipped a photo with an unexpected key', { key });
        missing.add(key);
        continue;
      }
      const fetched = storage().getStream('media', key);
      const body = await step(fetched).catch((err: unknown) => {
        // A body that arrives after the export has failed is closed, not left open.
        fetched.then((late) => late?.destroy(), () => undefined);
        throw err;
      });
      if (!body) {
        logger.warn('Export skipped a missing photo', { key });
        missing.add(key);
        continue;
      }
      source = body;
      source.on('error', fail);
      // JPEGs are already compressed: store them as they are.
      await append(name, source, { store: true });
      source = null;
    }

    for (const [name, data] of Object.entries(small)) {
      await append(name, JSON.stringify(data, null, 2));
    }
    for (const file of STREAMED_FILES) {
      // objectMode off: archiver reads bytes, not a stream of string objects.
      source = Readable.from(
        jsonArrayFromCursor(client, file.text, accountId, file.transform, missing),
        { objectMode: false },
      );
      source.on('error', fail);
      await append(file.name, source);
      source = null;
    }
    await append('README.txt', readme());
    await step(archive.finalize());
    await step(uploaded);
  } catch (err) {
    source?.destroy();
    archive.abort();
    output.destroy(err instanceof Error ? err : new Error(String(err)));
    await uploaded.catch(() => undefined);
    throw err;
  }
}

// Runs in the background after POST /api/me/export responds — never awaited
// by the request handler, so it must never throw.
export async function processExportJob(jobId: number): Promise<void> {
  try {
    const { rows } = await db.query<{ account_id: number }>(
      `UPDATE data_export_jobs SET status = 'processing'
       WHERE id = $1 AND status = 'pending'
       RETURNING account_id`,
      [jobId],
    );
    if (rows.length === 0) {
      logger.warn('Export job not found or not pending', { jobId });
      return;
    }
    const accountId = rows[0].account_id;

    const key = exportKey(accountId, jobId);

    const client = await db.connect();
    let failed: Error | undefined;
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await streamExport(client, accountId, key);
      await client.query('COMMIT');
    } catch (err) {
      failed = err instanceof Error ? err : new Error(String(err));
      throw err;
    } finally {
      // On failure the connection is discarded, not rolled back: a cursor a
      // failed entry left open would hold a ROLLBACK in the client's queue
      // forever. Closing the connection ends the transaction server-side.
      client.release(failed);
    }

    await db.query(
      `UPDATE data_export_jobs
       SET status = 'complete', completed_at = now(), expires_at = now() + interval '7 days'
       WHERE id = $1`,
      [jobId],
    );
    logger.info('Export job complete', { jobId, accountId });
  } catch (err) {
    logger.error('Export job failed', err, { jobId });
    try {
      await db.query(`UPDATE data_export_jobs SET status = 'failed' WHERE id = $1`, [jobId]);
    } catch (updateErr) {
      logger.error('Could not mark export job failed', updateErr, { jobId });
    }
  }
}

import { PassThrough } from 'stream';
import { ZipArchive } from 'archiver';
import { types as pgTypes, CustomTypesConfig } from 'pg';
import { db } from './db';
import { logger } from './logger';
import { uploadToR2, getPresignedDownloadUrl, exportsBucket } from './r2';

export const EXPORT_DOWNLOAD_TTL_SECONDS = 604800; // 7 days

export function exportKey(accountId: number, jobId: number): string {
  return `exports/${accountId}/${jobId}.zip`;
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

async function query(text: string, accountId: number): Promise<Row[]> {
  const { rows } = await db.query<Row>({ text, values: [accountId], types: exportTypes });
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

export async function collectExportData(accountId: number): Promise<Record<string, unknown>> {
  const [
    accountRows,
    gardens,
    beds,
    plantings,
    personalSeeds,
    seedPhotos,
    harvestEntries,
    sowingEvents,
    seedPreferences,
    soilReadings,
    amendmentLogs,
    weatherConnections,
    feedbackSubmissions,
    microFeedback,
    usageEvents,
  ] = await Promise.all([
    query(
      `SELECT to_jsonb(a) - 'password_hash' - 'stripe_customer_id' - 'stripe_subscription_id'
         AS account
       FROM accounts a WHERE a.id = $1`,
      accountId,
    ),
    query('SELECT * FROM gardens WHERE owner_id = $1 ORDER BY id', accountId),
    query(`SELECT * FROM beds WHERE garden_id IN (${ACCOUNT_GARDENS}) ORDER BY id`, accountId),
    query(
      `SELECT t.*, COALESCE(s.common_name, cs.common_name) AS common_name
       FROM plantings t ${COMMON_NAME_JOINS}
       WHERE t.garden_id IN (${ACCOUNT_GARDENS})
       ORDER BY t.id`,
      accountId,
    ),
    query('SELECT * FROM seeds WHERE owner_id = $1 ORDER BY id', accountId),
    query(
      `SELECT sp.id, sp.seed_id, sp.storage_url, sp.taken_at, sp.notes, sp.created_at
       FROM seed_photos sp
       JOIN seeds s ON s.id = sp.seed_id
       WHERE s.owner_id = $1
       ORDER BY sp.id`,
      accountId,
    ),
    // harvest_entries has no bed_id column, so no bed label is exported.
    query(
      `SELECT t.*, COALESCE(s.common_name, cs.common_name) AS common_name,
              g.name AS garden_name
       FROM harvest_entries t
       JOIN gardens g ON g.id = t.garden_id ${COMMON_NAME_JOINS}
       WHERE g.owner_id = $1
       ORDER BY t.id`,
      accountId,
    ),
    query(
      `SELECT t.*, COALESCE(s.common_name, cs.common_name) AS common_name
       FROM sowing_events t ${COMMON_NAME_JOINS}
       WHERE t.garden_id IN (${ACCOUNT_GARDENS})
       ORDER BY t.id`,
      accountId,
    ),
    query('SELECT * FROM user_seed_preferences WHERE account_id = $1 ORDER BY id', accountId),
    query(
      `SELECT * FROM soil_readings WHERE garden_id IN (${ACCOUNT_GARDENS}) ORDER BY id`,
      accountId,
    ),
    query(
      `SELECT al.*,
              COALESCE(
                array_agg(alb.bed_id ORDER BY alb.bed_id) FILTER (WHERE alb.bed_id IS NOT NULL),
                '{}'::int[]
              ) AS bed_ids
       FROM amendment_logs al
       LEFT JOIN amendment_log_beds alb ON alb.amendment_log_id = al.id
       WHERE al.garden_id IN (${ACCOUNT_GARDENS})
       GROUP BY al.id
       ORDER BY al.id`,
      accountId,
    ),
    // credentials is deliberately never selected.
    query(
      `SELECT id, provider, station_id, is_primary, last_successful_sync, created_at
       FROM weather_connections WHERE account_id = $1 ORDER BY id`,
      accountId,
    ),
    query('SELECT * FROM feedback_submissions WHERE user_id = $1 ORDER BY id', accountId),
    query('SELECT * FROM micro_feedback_responses WHERE account_id = $1 ORDER BY id', accountId),
    query(
      'SELECT event_key, created_at FROM usage_events WHERE user_id = $1 ORDER BY created_at, id',
      accountId,
    ),
  ]);

  const bedsByGarden = new Map<unknown, Row[]>();
  for (const bed of beds) {
    const list = bedsByGarden.get(bed.garden_id) ?? [];
    list.push(formatRow(bed));
    bedsByGarden.set(bed.garden_id, list);
  }

  const accountJson = accountRows[0]?.account as Row | undefined;

  return {
    'account.json': accountJson ? formatRow(accountJson) : null,
    'gardens.json': gardens.map((g) => ({ ...formatRow(g), beds: bedsByGarden.get(g.id) ?? [] })),
    'plantings.json': plantings.map(formatRow),
    'personal_seeds.json': personalSeeds.map(formatRow),
    'seed_photos.json': seedPhotos.map(formatRow),
    'harvest_entries.json': harvestEntries.map(formatRow),
    'sowing_events.json': sowingEvents.map(formatRow),
    'seed_preferences.json': seedPreferences.map(formatRow),
    'soil_readings.json': soilReadings.map(formatRow),
    'amendment_logs.json': amendmentLogs.map(formatRow),
    'weather_connections.json': weatherConnections.map(formatRow),
    'feedback.json': {
      submissions: feedbackSubmissions.map(formatRow),
      microFeedback: microFeedback.map(formatRow),
    },
    'usage_events.json': usageEvents.map(formatRow),
  };
}

async function buildZip(files: Record<string, unknown>): Promise<Buffer> {
  const exportedOn = new Date().toLocaleDateString('en-US', {
    timeZone: 'America/Los_Angeles',
    dateStyle: 'long',
  });

  const archive = new ZipArchive({ zlib: { level: 9 } });
  const output = new PassThrough();
  const chunks: Buffer[] = [];

  const done = new Promise<Buffer>((resolve, reject) => {
    output.on('data', (chunk: Buffer) => chunks.push(chunk));
    output.on('end', () => resolve(Buffer.concat(chunks)));
    output.on('error', reject);
    archive.on('error', reject);
  });

  archive.pipe(output);
  for (const [name, data] of Object.entries(files)) {
    archive.append(JSON.stringify(data, null, 2), { name });
  }
  archive.append(`Your Vernal data, exported ${exportedOn}. Photos are listed by URL.\n`, {
    name: 'README.txt',
  });
  await archive.finalize();

  return done;
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

    const data = await collectExportData(accountId);
    const zip = await buildZip(data);

    // Exports go to the private bucket; uploadToR2's public URL is meaningless there.
    const bucket = exportsBucket();
    const key = exportKey(accountId, jobId);
    await uploadToR2(key, zip, 'application/zip', bucket);
    const downloadUrl = await getPresignedDownloadUrl(key, EXPORT_DOWNLOAD_TTL_SECONDS, bucket);

    await db.query(
      `UPDATE data_export_jobs
       SET status = 'complete', completed_at = now(), download_url = $2,
           expires_at = now() + interval '7 days'
       WHERE id = $1`,
      [jobId, downloadUrl],
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

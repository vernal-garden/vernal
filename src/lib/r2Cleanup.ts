import type { PoolClient } from 'pg';
import { db } from './db';
import { logger } from './logger';
import { storage, type Area } from './storage';
import { gardenThumbnailFolder, harvestPhotoFolder } from './storage/keys';

// The R2 cleanup queue. Every delete that owns R2 files queues them here in the
// same transaction as the DB delete, then calls drainSoon() after COMMIT; the
// nightly job drains whatever is left. A row goes only once R2 confirms.

export type R2Deletion = { bucket: 'public' | 'exports'; path: string; isPrefix: boolean };

type Queryable = Pick<PoolClient, 'query'>;

// A presigned upload URL lives 5 minutes, so a PUT can land after the first
// folder delete. Prefix rows stay until a delete succeeds after this age.
const PREFIX_SETTLE_MINUTES = 10;
const ERROR_AFTER_ATTEMPTS = 7;

export async function queueR2Deletions(q: Queryable, items: R2Deletion[]): Promise<number[]> {
  if (items.length === 0) return [];
  const { rows } = await q.query<{ id: string }>(
    `INSERT INTO r2_deletions (bucket, path, is_prefix)
     SELECT * FROM unnest($1::text[], $2::text[], $3::boolean[])
     RETURNING id`,
    [items.map((i) => i.bucket), items.map((i) => i.path), items.map((i) => i.isPrefix)],
  );
  return rows.map((r) => Number(r.id));
}

// The R2 folders each garden owns: its thumbnails and each harvest's photos.
// Must run before the garden is deleted — the cascade removes the harvest rows.
// Must run inside a transaction, with the gardens already locked FOR UPDATE:
// the harvest rows are locked too, so a concurrent move of a harvest out of
// the garden waits for us (and one that moved first isn't returned), while the
// garden lock blocks a harvest being inserted or moved in (the FK takes KEY
// SHARE). Otherwise a harvest's photos could be missed or queued twice.
export async function gardenFiles(
  q: Queryable,
  gardenIds: number[],
): Promise<Map<number, R2Deletion[]>> {
  const files = new Map<number, R2Deletion[]>();
  for (const id of gardenIds) {
    files.set(id, [{ bucket: 'public', path: gardenThumbnailFolder(id), isPrefix: true }]);
  }
  if (gardenIds.length === 0) return files;
  const { rows } = await q.query<{ id: number; garden_id: number }>(
    'SELECT id, garden_id FROM harvest_entries WHERE garden_id = ANY($1::int[]) FOR UPDATE',
    [gardenIds],
  );
  for (const { id, garden_id } of rows) {
    files.get(garden_id)?.push({ bucket: 'public', path: harvestPhotoFolder(id), isPrefix: true });
  }
  return files;
}

// Collects the candidates' files, runs deleteSql (which must use $1 as the
// candidate id array and RETURNING id), then queues files only for the gardens
// it actually deleted. Must be called inside a transaction (the locks below
// last until COMMIT).
export async function queueDeletedGardens(
  client: Queryable,
  candidateIds: number[],
  deleteSql: string,
  params: unknown[] = [],
): Promise<{ deleted: number[]; ids: number[] }> {
  if (candidateIds.length === 0) return { deleted: [], ids: [] };
  // Lock the gardens before reading their harvests; see gardenFiles.
  await client.query('SELECT id FROM gardens WHERE id = ANY($1::int[]) FOR UPDATE', [candidateIds]);
  const files = await gardenFiles(client, candidateIds);
  const { rows } = await client.query<{ id: number }>(deleteSql, [candidateIds, ...params]);
  const deleted = rows.map((r) => Number(r.id));
  const ids = await queueR2Deletions(client, deleted.flatMap((id) => files.get(id) ?? []));
  return { deleted, ids };
}

// gardens.guest_session_id is ON DELETE CASCADE, so deleting a session row
// would silently take its unmerged guest gardens (and their harvests) with it.
// Deletes and queues them first; returns the queued ids. Call inside a
// transaction, before the session row delete.
export async function queueSessionGardens(
  client: Queryable,
  sessionIds: string[],
): Promise<number[]> {
  if (sessionIds.length === 0) return [];
  const { rows } = await client.query<{ id: number }>(
    'SELECT id FROM gardens WHERE guest_session_id = ANY($1::uuid[])',
    [sessionIds],
  );
  const { ids } = await queueDeletedGardens(
    client,
    rows.map((r) => r.id),
    'DELETE FROM gardens WHERE id = ANY($1::int[]) RETURNING id',
  );
  return ids;
}

// failed counts rows that keep failing (7+ attempts); a first failure is
// retried tomorrow and doesn't count. A stuck row keeps the nightly run failed
// until someone fixes the cause or deletes the row (its last_error says why).
export async function drainR2Deletions(
  { ids, limit = 1000 }: { ids?: number[]; limit?: number } = {},
): Promise<{ affected: number; failed: number }> {
  const { rows } = await db.query<{
    id: string;
    bucket: 'public' | 'exports';
    path: string;
    is_prefix: boolean;
    settled: boolean;
  }>(
    `SELECT id, bucket, path, is_prefix,
            created_at < NOW() - make_interval(mins => $3) AS settled
       FROM r2_deletions
      WHERE ($1::bigint[] IS NULL OR id = ANY($1::bigint[]))
      -- Fewest attempts first, so rows that keep failing can't fill the limit.
      ORDER BY attempts, id
      LIMIT $2`,
    [ids ?? null, limit, PREFIX_SETTLE_MINUTES],
  );

  let affected = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      // The queue's bucket column predates storage areas: 'public' is media.
      const area: Area = row.bucket === 'exports' ? 'exports' : 'media';
      if (row.is_prefix) await storage().removePrefix(area, row.path);
      else await storage().remove(area, row.path);
      // Deletes are idempotent, so a concurrent drain of the same row is harmless.
      if (!row.is_prefix || row.settled) {
        await db.query('DELETE FROM r2_deletions WHERE id = $1', [row.id]);
        affected += 1;
      }
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      const { rows: updated } = await db.query<{ attempts: number }>(
        `UPDATE r2_deletions SET attempts = attempts + 1, last_error = $2
          WHERE id = $1 RETURNING attempts`,
        [row.id, message],
      );
      const attempts = updated[0]?.attempts ?? 0;
      const meta = { id: row.id, bucket: row.bucket, path: row.path, attempts, errMsg: message };
      if (attempts >= ERROR_AFTER_ATTEMPTS) {
        failed += 1;
        logger.error('R2 delete keeps failing', err, meta);
      } else {
        logger.warn('R2 delete failed; will retry nightly', meta);
      }
    }
  }
  return { affected, failed };
}

// Fire-and-forget drain of rows just committed. Never awaited by a response.
export function drainSoon(ids: number[]): void {
  if (ids.length === 0) return;
  drainR2Deletions({ ids }).catch((err: unknown) => {
    logger.warn('Immediate R2 drain failed; nightly will retry', {
      errMsg: err instanceof Error ? err.message : String(err),
    });
  });
}

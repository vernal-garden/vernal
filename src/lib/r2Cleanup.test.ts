import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { Pool } from 'pg';

vi.mock('./r2', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./r2')>()),
  deleteFromR2: vi.fn(),
  deletePrefixFromR2: vi.fn(),
  exportsBucket: vi.fn(() => 'test-exports'),
}));

vi.mock('./logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { deleteFromR2, deletePrefixFromR2 } from './r2';
import { logger } from './logger';
import { queueR2Deletions, gardenFiles, drainR2Deletions, queueDeletedGardens } from './r2Cleanup';

const deleteFromR2Mock = vi.mocked(deleteFromR2);
const deletePrefixMock = vi.mocked(deletePrefixFromR2);

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL must be set to run tests');
const pool = new Pool({ connectionString: url });

async function rows() {
  const { rows } = await pool.query<{ id: string; bucket: string; path: string; is_prefix: boolean; attempts: number; last_error: string | null }>(
    'SELECT id, bucket, path, is_prefix, attempts, last_error FROM r2_deletions ORDER BY id',
  );
  return rows;
}

async function ageAll(minutes: number) {
  await pool.query(`UPDATE r2_deletions SET created_at = NOW() - make_interval(mins => $1)`, [minutes]);
}

async function createGarden(): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO accounts (email, zone, zone_location_label, email_verified)
     VALUES ('r2c' || floor(random() * 1e9)::text || '@example.com', '7b', 'x', true) RETURNING id`,
  );
  const g = await pool.query<{ id: number }>(
    `INSERT INTO gardens (owner_id, name, style, zone) VALUES ($1, 'G', 'grid', '7b') RETURNING id`,
    [rows[0].id],
  );
  return g.rows[0].id;
}

beforeEach(async () => {
  await pool.query('TRUNCATE r2_deletions, accounts, gardens RESTART IDENTITY CASCADE');
  deleteFromR2Mock.mockReset().mockResolvedValue(undefined);
  deletePrefixMock.mockReset().mockResolvedValue(undefined);
  vi.mocked(logger.warn).mockClear();
  vi.mocked(logger.error).mockClear();
});

afterAll(() => pool.end());

describe('queueR2Deletions', () => {
  it('inserts the rows and returns their ids', async () => {
    const ids = await queueR2Deletions(pool, [
      { bucket: 'public', path: 'seed-photos/1/', isPrefix: true },
      { bucket: 'exports', path: 'exports/2/9.zip', isPrefix: false },
    ]);
    expect(ids).toHaveLength(2);
    expect(await rows()).toMatchObject([
      { bucket: 'public', path: 'seed-photos/1/', is_prefix: true, attempts: 0 },
      { bucket: 'exports', path: 'exports/2/9.zip', is_prefix: false },
    ]);
  });

  it('does nothing for an empty list', async () => {
    expect(await queueR2Deletions(pool, [])).toEqual([]);
    expect(await rows()).toEqual([]);
  });
});

describe('gardenFiles', () => {
  it('lists the thumbnail folder and every harvest folder per garden', async () => {
    const gardenId = await createGarden();
    const { rows: h } = await pool.query<{ id: number }>(
      `INSERT INTO harvest_entries (garden_id) VALUES ($1), ($1) RETURNING id`,
      [gardenId],
    );
    const files = await gardenFiles(pool, [gardenId]);
    expect(files.get(gardenId)).toEqual(
      expect.arrayContaining([
        { bucket: 'public', path: `garden-thumbnails/${gardenId}/`, isPrefix: true },
        { bucket: 'public', path: `harvest-photos/${h[0].id}/`, isPrefix: true },
        { bucket: 'public', path: `harvest-photos/${h[1].id}/`, isPrefix: true },
      ]),
    );
    expect(files.get(gardenId)).toHaveLength(3);
  });
});

describe('queueDeletedGardens', () => {
  it('queues files only for the gardens the DELETE returned', async () => {
    const kept = await createGarden();
    const gone = await createGarden();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { deleted, ids } = await queueDeletedGardens(
        client,
        [kept, gone],
        'DELETE FROM gardens WHERE id = ANY($1::int[]) AND id = $2 RETURNING id',
        [gone],
      );
      await client.query('COMMIT');
      expect(deleted).toEqual([gone]);
      expect(ids).toHaveLength(1);
    } finally {
      client.release();
    }
    expect((await rows()).map((r) => r.path)).toEqual([`garden-thumbnails/${gone}/`]);
  });
});

describe('drainR2Deletions', () => {
  it('deletes a file and removes its row', async () => {
    await queueR2Deletions(pool, [{ bucket: 'public', path: 'seed-photos/1/a.jpg', isPrefix: false }]);
    const { affected } = await drainR2Deletions();
    expect(deleteFromR2Mock).toHaveBeenCalledWith('seed-photos/1/a.jpg', undefined);
    expect(affected).toBe(1);
    expect(await rows()).toEqual([]);
  });

  it('uses the exports bucket for exports rows', async () => {
    await queueR2Deletions(pool, [{ bucket: 'exports', path: 'exports/2/', isPrefix: true }]);
    await ageAll(11);
    await drainR2Deletions();
    expect(deletePrefixMock).toHaveBeenCalledWith('exports/2/', 'test-exports');
  });

  it('keeps a prefix row younger than 10 minutes after deleting it', async () => {
    await queueR2Deletions(pool, [{ bucket: 'public', path: 'seed-photos/1/', isPrefix: true }]);
    const { affected } = await drainR2Deletions();
    expect(deletePrefixMock).toHaveBeenCalledWith('seed-photos/1/', undefined);
    expect(affected).toBe(0);
    expect(await rows()).toHaveLength(1);
  });

  it('removes a prefix row older than 10 minutes', async () => {
    await queueR2Deletions(pool, [{ bucket: 'public', path: 'seed-photos/1/', isPrefix: true }]);
    await ageAll(11);
    expect((await drainR2Deletions()).affected).toBe(1);
    expect(await rows()).toEqual([]);
  });

  it('records a failure and keeps the row', async () => {
    deleteFromR2Mock.mockRejectedValueOnce(new Error('R2 down'));
    await queueR2Deletions(pool, [{ bucket: 'public', path: 'k', isPrefix: false }]);
    const result = await drainR2Deletions();
    expect(result).toEqual({ affected: 0, failed: 0 });
    expect(await rows()).toMatchObject([{ attempts: 1, last_error: 'R2 down' }]);
    expect(logger.warn).toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs an error once a row reaches 7 attempts', async () => {
    await queueR2Deletions(pool, [{ bucket: 'public', path: 'k', isPrefix: false }]);
    await pool.query('UPDATE r2_deletions SET attempts = 6');
    deleteFromR2Mock.mockRejectedValueOnce(new Error('R2 down'));
    const result = await drainR2Deletions();
    expect(result).toEqual({ affected: 0, failed: 1 });
    expect(await rows()).toMatchObject([{ attempts: 7 }]);
    expect(logger.error).toHaveBeenCalled();
  });

  it('a misconfigured exports bucket fails only that row', async () => {
    const { exportsBucket } = await import('./r2');
    vi.mocked(exportsBucket).mockImplementationOnce(() => {
      throw new Error('R2_EXPORTS_BUCKET_NAME is not set.');
    });
    await queueR2Deletions(pool, [
      { bucket: 'exports', path: 'exports/2/1.zip', isPrefix: false },
      { bucket: 'public', path: 'k', isPrefix: false },
    ]);
    expect((await drainR2Deletions()).affected).toBe(1);
    expect(await rows()).toMatchObject([{ path: 'exports/2/1.zip', attempts: 1 }]);
  });

  it('only drains the given ids', async () => {
    const [first] = await queueR2Deletions(pool, [{ bucket: 'public', path: 'a', isPrefix: false }]);
    await queueR2Deletions(pool, [{ bucket: 'public', path: 'b', isPrefix: false }]);
    await drainR2Deletions({ ids: [first] });
    expect(deleteFromR2Mock).toHaveBeenCalledTimes(1);
    expect((await rows()).map((r) => r.path)).toEqual(['b']);
  });

  it('stops at the limit', async () => {
    await queueR2Deletions(pool, [
      { bucket: 'public', path: 'a', isPrefix: false },
      { bucket: 'public', path: 'b', isPrefix: false },
    ]);
    await drainR2Deletions({ limit: 1 });
    expect((await rows()).map((r) => r.path)).toEqual(['b']);
  });

  it('drains fresh rows before rows that keep failing', async () => {
    await queueR2Deletions(pool, [
      { bucket: 'public', path: 'failing', isPrefix: false },
      { bucket: 'public', path: 'fresh', isPrefix: false },
    ]);
    await pool.query("UPDATE r2_deletions SET attempts = 5 WHERE path = 'failing'");
    await drainR2Deletions({ limit: 1 });
    expect(deleteFromR2Mock).toHaveBeenCalledWith('fresh', undefined);
    expect((await rows()).map((r) => r.path)).toEqual(['failing']);
  });
});

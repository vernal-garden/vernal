import type { PoolClient } from 'pg';

// Per-collection row caps. Creates past a cap get a 409; rows that already
// exist over a cap are left alone.
export const LIMITS = {
  gardensPerAccount: 50,
  bedsPerGarden: 200,
  seedsPerAccount: 2000,
  weatherConnectionsPerAccount: 5,
  plantingsPerFreeformBed: 1000,
  soilReadingsPerGarden: 500,
  amendmentsPerGarden: 1000,
  harvestEntriesPerGarden: 5000,
  correctionsPerDay: 10,
} as const;

export type CapResult = 'ok' | 'full' | 'missing';

// Locks the parent row, counts its children and says whether `adding` more
// fit under `max` ('ok' / 'full'), or 'missing' when the parent row is gone.
// Run inside the caller's transaction so the lock holds until the insert
// commits; that serialises concurrent creates on the same parent.
//
// lockSql must take FOR NO KEY UPDATE, not FOR UPDATE. NO KEY UPDATE still
// conflicts with itself (so cap checks serialise) but not with the KEY SHARE
// lock Postgres takes on the parent when a child row is inserted, so it can't
// deadlock against a concurrent insert that references the same parent.
// countSql must return one row with an integer column `n`.
export async function withinCap(
  client: PoolClient,
  opts: { lockSql: string; countSql: string; params: unknown[]; max: number; adding?: number },
): Promise<CapResult> {
  if (!/FOR NO KEY UPDATE/i.test(opts.lockSql)) {
    throw new Error('withinCap lockSql must use FOR NO KEY UPDATE');
  }
  const locked = await client.query(opts.lockSql, opts.params);
  if (locked.rowCount === 0) return 'missing';
  const { rows } = await client.query<{ n: number }>(opts.countSql, opts.params);
  return rows[0].n + (opts.adding ?? 1) <= opts.max ? 'ok' : 'full';
}

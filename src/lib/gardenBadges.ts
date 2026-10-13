import type { PoolClient } from 'pg';

// gardens.harvestable_count: harvest-ready plantings nobody has dismissed.
// `gardenIdSql` is the SQL expression holding the garden id (a column
// reference or a placeholder). Shared by the nightly refreshGardenBadges and
// the per-garden recompute below so the two can't drift.
export function harvestableCountSql(gardenIdSql: string): string {
  return `(
    SELECT COUNT(*)::int FROM plantings p
    WHERE p.garden_id = ${gardenIdSql}
      AND p.harvest_ready = true
      AND p.indicator_dismissed_at IS NULL
  )`;
}

export async function recomputeHarvestableCount(
  client: Pick<PoolClient, 'query'>,
  gardenId: number,
): Promise<void> {
  await client.query(
    `UPDATE gardens SET harvestable_count = ${harvestableCountSql('$1::int')}, updated_at = NOW()
     WHERE id = $1::int`,
    [gardenId],
  );
}

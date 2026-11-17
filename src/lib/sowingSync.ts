import type { PoolClient } from 'pg';

// A planting, preference or sowing event is keyed by its personal seed when it
// has one, otherwise by its Cambium seed.
export type SeedKey = { kind: 'seed'; id: number } | { kind: 'cambium'; id: number };

export function seedKeyString(key: SeedKey): string {
  return `${key.kind}:${key.id}`;
}

// SQL predicate matching a SeedKey against seed_id / cambium_seed_id columns.
// `param` is the placeholder holding key.id.
export function seedKeyWhere(key: SeedKey, param: string): string {
  return key.kind === 'seed'
    ? `seed_id = ${param}`
    : `seed_id IS NULL AND cambium_seed_id = ${param}`;
}

// Takes the transaction-scoped advisory lock that serialises writes to a
// (garden, seed, season) sowing event. Re-entrant within a transaction, so a
// caller may take it before syncSowingEvent takes it again.
export async function lockSowingKey(
  client: PoolClient,
  gardenId: number,
  seedKey: SeedKey,
  season: number,
): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
    `sow:${gardenId}:${seedKeyString(seedKey)}:${season}`,
  ]);
}

// Keeps a (garden, seed, season) sowing event in step with its plantings:
// placing a plant sows it. While plantings remain, the event (the lowest-id
// one for the key, as the guide reads it) is done at noon Pacific on the
// earliest planting date, falling back to the Pacific date a planting was
// created while planting_date is still nullable. With none left, the event is
// un-done but kept, since harvest entries may reference it.
//
// Must run inside a transaction the caller opened: the advisory lock is
// transaction-scoped and serialises against other syncs for the same key.
export async function syncSowingEvent(
  client: PoolClient,
  gardenId: number,
  seedKey: SeedKey,
  season: number,
): Promise<void> {
  await lockSowingKey(client, gardenId, seedKey, season);

  const { rows: plantings } = await client.query<{ first_id: number | null; done_at: Date | null }>(
    `SELECT MIN(id) AS first_id,
            (MIN(COALESCE(planting_date, (created_at AT TIME ZONE 'America/Los_Angeles')::date))
              + time '12:00') AT TIME ZONE 'America/Los_Angeles' AS done_at
     FROM plantings
     WHERE garden_id = $1 AND ${seedKeyWhere(seedKey, '$2')} AND season = $3`,
    [gardenId, seedKey.id, season],
  );
  const { first_id: firstPlantingId, done_at: doneAt } = plantings[0];

  const { rows: existing } = await client.query<{ id: number }>(
    `SELECT id FROM sowing_events
     WHERE garden_id = $1 AND ${seedKeyWhere(seedKey, '$2')} AND season = $3
     ORDER BY id LIMIT 1`,
    [gardenId, seedKey.id, season],
  );
  const eventId = existing[0]?.id ?? null;

  if (eventId !== null) {
    await client.query(
      `UPDATE sowing_events SET marked_done_at = $2
       WHERE id = $1 AND marked_done_at IS DISTINCT FROM $2`,
      [eventId, doneAt],
    );
  } else if (firstPlantingId !== null) {
    // Shaped like the guide's done insert: a personal-seed key never carries
    // a Cambium id, so it can't match a Cambium-only key.
    await client.query(
      `INSERT INTO sowing_events
         (planting_id, garden_id, seed_id, cambium_seed_id, season, marked_done_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        firstPlantingId,
        gardenId,
        seedKey.kind === 'seed' ? seedKey.id : null,
        seedKey.kind === 'cambium' ? seedKey.id : null,
        season,
        doneAt,
      ],
    );
  }
}

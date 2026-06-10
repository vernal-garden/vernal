import { db } from '../lib/db';
import type {
  SeedSummary,
  SeedDetail,
  CompanionEntry,
  SeedSearchOptions,
} from '../types/cambium';

const COMPANION_CONFIDENCE_THRESHOLD = 40;

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function rowToSeedSummary(row: Record<string, unknown>): SeedSummary {
  return {
    id: String(row.id),
    commonName: row.common_name as string,
    scientificName: (row.scientific_name as string | null) ?? null,
    plantFamily: (row.plant_family as string | null) ?? null,
    illustrationKey: (row.illustration_key as string | null) ?? null,
    aggregateRating: row.aggregate_rating != null ? Number(row.aggregate_rating) : null,
    ratingCount: row.rating_count as number,
  };
}

// ---------------------------------------------------------------------------
// Public service functions
// ---------------------------------------------------------------------------

export async function searchSeeds(
  options: SeedSearchOptions,
): Promise<{ data: SeedSummary[]; total: number }> {
  const { query, family, limit = 20, offset = 0 } = options;

  const countParams: unknown[] = [];
  let countWhere = `WHERE moderation_status = 'active'`;

  if (query) {
    countParams.push(`%${query}%`);
    countWhere += ` AND (common_name ILIKE $${countParams.length} OR scientific_name ILIKE $${countParams.length})`;
  }

  if (family) {
    countParams.push(family);
    countWhere += ` AND plant_family = $${countParams.length}`;
  }

  const countResult = await db.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM cambium.seeds ${countWhere}`,
    countParams,
  );

  const total = parseInt(countResult.rows[0].count, 10);
  if (total === 0) return { data: [], total };

  const dataParams: unknown[] = [];
  let dataWhere = `WHERE moderation_status = 'active'`;
  let orderBy: string;

  if (query) {
    dataParams.push(`%${query}%`);
    dataWhere += ` AND (common_name ILIKE $${dataParams.length} OR scientific_name ILIKE $${dataParams.length})`;
    dataParams.push(`${query}%`);
    orderBy = `ORDER BY (common_name ILIKE $${dataParams.length}) DESC, common_name ASC`;
  } else {
    orderBy = `ORDER BY common_name ASC`;
  }

  if (family) {
    dataParams.push(family);
    dataWhere += ` AND plant_family = $${dataParams.length}`;
  }

  dataParams.push(limit);
  const limitClause = `LIMIT $${dataParams.length}`;
  dataParams.push(offset);
  const offsetClause = `OFFSET $${dataParams.length}`;

  const dataResult = await db.query<{
    id: number;
    common_name: string;
    scientific_name: string | null;
    plant_family: string | null;
    illustration_key: string | null;
    aggregate_rating: string | null;
    rating_count: number;
  }>(
    `SELECT id, common_name, scientific_name, plant_family, illustration_key, aggregate_rating, rating_count
     FROM cambium.seeds
     ${dataWhere}
     ${orderBy}
     ${limitClause} ${offsetClause}`,
    dataParams,
  );

  const data: SeedSummary[] = dataResult.rows.map(rowToSeedSummary);

  return { data, total };
}

export async function listFamilies(): Promise<{ family: string; count: number }[]> {
  const result = await db.query<{ plant_family: string; count: number }>(
    `SELECT plant_family, COUNT(*)::int AS count
     FROM cambium.seeds
     WHERE moderation_status = 'active' AND plant_family IS NOT NULL
     GROUP BY plant_family
     ORDER BY plant_family`,
  );

  return result.rows.map((r) => ({
    family: r.plant_family,
    count: r.count,
  }));
}

export async function getSeedById(id: number): Promise<SeedDetail | null> {
  const result = await db.query(
    `SELECT id, common_name, scientific_name, plant_family, illustration_key,
            aggregate_rating, rating_count,
            spacing_inches, maturity_days_min, maturity_days_max,
            sunlight, watering_needs,
            hardiness_zone_min, hardiness_zone_max,
            frost_tolerance, weeks_to_transplant, succession_interval_weeks,
            planting_depth_inches, row_spacing_inches,
            germination_days_min, germination_days_max,
            germination_temp_min_f, germination_temp_max_f,
            source
     FROM cambium.seeds
     WHERE id = $1 AND moderation_status = 'active'`,
    [id],
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0] as Record<string, unknown>;
  const companions = await getCompanionsForSeed(id);

  // getCompanionsForSeed returns null when seed doesn't exist, but we already
  // confirmed it exists above, so treat null as empty array.
  return {
    id: String(row.id),
    commonName: row.common_name as string,
    scientificName: (row.scientific_name as string | null) ?? null,
    plantFamily: (row.plant_family as string | null) ?? null,
    illustrationKey: (row.illustration_key as string | null) ?? null,
    aggregateRating: row.aggregate_rating != null ? Number(row.aggregate_rating) : null,
    ratingCount: row.rating_count as number,
    spacingInches: row.spacing_inches != null ? Number(row.spacing_inches) : null,
    maturityDaysMin: (row.maturity_days_min as number | null) ?? null,
    maturityDaysMax: (row.maturity_days_max as number | null) ?? null,
    sunlight: (row.sunlight as string | null) ?? null,
    wateringNeeds: (row.watering_needs as string | null) ?? null,
    hardinessZoneMin: (row.hardiness_zone_min as string | null) ?? null,
    hardinessZoneMax: (row.hardiness_zone_max as string | null) ?? null,
    frostTolerance: (row.frost_tolerance as string | null) ?? null,
    weeksToTransplant: (row.weeks_to_transplant as number | null) ?? null,
    successionIntervalWeeks: (row.succession_interval_weeks as number | null) ?? null,
    plantingDepthInches: row.planting_depth_inches != null ? Number(row.planting_depth_inches) : null,
    rowSpacingInches: row.row_spacing_inches != null ? Number(row.row_spacing_inches) : null,
    germinationDaysMin: (row.germination_days_min as number | null) ?? null,
    germinationDaysMax: (row.germination_days_max as number | null) ?? null,
    germinationTempMinF: (row.germination_temp_min_f as number | null) ?? null,
    germinationTempMaxF: (row.germination_temp_max_f as number | null) ?? null,
    source: row.source as 'openfarm' | 'community' | 'editorial',
    companions: companions ?? [],
  };
}

export async function getCompanionsForSeed(
  id: number,
  options?: { relationship?: 'beneficial' | 'antagonistic' | 'neutral' },
): Promise<CompanionEntry[] | null> {
  // Confirm seed exists and is active.
  const seedCheck = await db.query<{ id: number }>(
    `SELECT id FROM cambium.seeds WHERE id = $1 AND moderation_status = 'active'`,
    [id],
  );

  if (seedCheck.rows.length === 0) return null;

  const relationshipFilter = options?.relationship;
  const params: unknown[] = [id, COMPANION_CONFIDENCE_THRESHOLD];

  let relationshipClause = '';
  if (relationshipFilter) {
    params.push(relationshipFilter);
    relationshipClause = `AND c.relationship = $${params.length}`;
  }

  const result = await db.query(
    `SELECT c.relationship, c.confidence, c.notes, c.source,
            s.id, s.common_name, s.scientific_name, s.plant_family,
            s.illustration_key, s.aggregate_rating, s.rating_count
     FROM cambium.companions c
     JOIN cambium.seeds s ON s.id = c.companion_seed_id
     WHERE c.seed_id = $1
       AND c.confidence >= $2
       AND s.moderation_status = 'active'
       ${relationshipClause}
     ORDER BY c.relationship, c.confidence DESC`,
    params,
  );

  return result.rows.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      seed: rowToSeedSummary(r),
      relationship: r.relationship as 'beneficial' | 'antagonistic' | 'neutral',
      confidence: r.confidence as number,
      notes: (r.notes as string | null) ?? null,
      source: (r.source as string | null) ?? null,
    };
  });
}

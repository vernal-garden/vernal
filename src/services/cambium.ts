import { db } from '../lib/db';
import type {
  PlantSummary,
  PlantDetail,
  GrowingAttributes,
  SoilPreferences,
  CompanionEntry,
  PlantTag,
  PlantSearchOptions,
} from '../types/cambium';

const COMPANION_CONFIDENCE_THRESHOLD = 40;

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function rowToTag(row: Record<string, unknown>): PlantTag {
  return {
    slug: row.tag_slug as string,
    label: row.tag_label as string,
    category: (row.tag_category as string | null) ?? null,
  };
}

function rowToSummary(row: Record<string, unknown>, tags: PlantTag[]): PlantSummary {
  return {
    id: String(row.id),
    slug: row.slug as string,
    botanicalName: row.botanical_name as string,
    commonNames: (row.common_names as string[]) ?? [],
    tags,
  };
}

function rowToGrowingAttributes(row: Record<string, unknown>): GrowingAttributes {
  return {
    daysToGerminationMin: (row.days_to_germination_min as number | null) ?? null,
    daysToGerminationMax: (row.days_to_germination_max as number | null) ?? null,
    daysToMaturityMin: (row.days_to_maturity_min as number | null) ?? null,
    daysToMaturityMax: (row.days_to_maturity_max as number | null) ?? null,
    spacingCmMin: (row.spacing_cm_min as number | null) ?? null,
    spacingCmMax: (row.spacing_cm_max as number | null) ?? null,
    rowSpacingCm: (row.row_spacing_cm as number | null) ?? null,
    plantHeightCmMin: (row.plant_height_cm_min as number | null) ?? null,
    plantHeightCmMax: (row.plant_height_cm_max as number | null) ?? null,
    sunRequirements: (row.sun_requirements as string | null) ?? null,
    waterRequirements: (row.water_requirements as string | null) ?? null,
    frostHardy: (row.frost_hardy as boolean | null) ?? null,
    directSow: (row.direct_sow as boolean | null) ?? null,
    transplant: (row.transplant as boolean | null) ?? null,
  };
}

function rowToSoilPreferences(row: Record<string, unknown>): SoilPreferences {
  return {
    phMin: row.ph_min != null ? Number(row.ph_min) : null,
    phMax: row.ph_max != null ? Number(row.ph_max) : null,
    nitrogenDemand: (row.nitrogen_demand as string | null) ?? null,
    phosphorusDemand: (row.phosphorus_demand as string | null) ?? null,
    potassiumDemand: (row.potassium_demand as string | null) ?? null,
    moisturePreference: (row.moisture_preference as string | null) ?? null,
    drainage: (row.drainage as string | null) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Tag helper (used by multiple queries)
// ---------------------------------------------------------------------------

async function fetchTagsForPlants(plantIds: bigint[]): Promise<Map<string, PlantTag[]>> {
  if (plantIds.length === 0) return new Map();

  const result = await db.query<{
    plant_id: string;
    tag_slug: string;
    tag_label: string;
    tag_category: string | null;
  }>(
    `SELECT pt.plant_id::text, t.slug AS tag_slug, t.label AS tag_label, t.category AS tag_category
     FROM cambium.plant_tags pt
     JOIN cambium.tags t ON t.id = pt.tag_id
     WHERE pt.plant_id = ANY($1::bigint[])
     ORDER BY t.category, t.label`,
    [plantIds.map(String)],
  );

  const map = new Map<string, PlantTag[]>();
  for (const row of result.rows) {
    const list = map.get(row.plant_id) ?? [];
    list.push(rowToTag(row));
    map.set(row.plant_id, list);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Public service functions
// ---------------------------------------------------------------------------

export async function searchPlants(options: PlantSearchOptions): Promise<{
  data: PlantSummary[];
  total: number;
}> {
  const { query, limit = 20, offset = 0, tagSlug } = options;
  const pattern = `%${query}%`;

  const countResult = await db.query<{ count: string }>(
    `SELECT COUNT(DISTINCT p.id)::text AS count
     FROM cambium.plants p
     ${tagSlug ? 'JOIN cambium.plant_tags pt ON pt.plant_id = p.id JOIN cambium.tags t ON t.id = pt.tag_id' : ''}
     WHERE p.is_published = true
       AND (
         p.botanical_name ILIKE $1
         OR EXISTS (
           SELECT 1 FROM unnest(p.common_names) AS cn WHERE cn ILIKE $1
         )
       )
     ${tagSlug ? 'AND t.slug = $2' : ''}`,
    tagSlug ? [pattern, tagSlug] : [pattern],
  );

  const total = parseInt(countResult.rows[0].count, 10);
  if (total === 0) return { data: [], total };

  const dataResult = await db.query<{
    id: string;
    slug: string;
    botanical_name: string;
    common_names: string[];
  }>(
    `SELECT id, slug, botanical_name, common_names
     FROM (
       SELECT DISTINCT p.id::text AS id, p.slug, p.botanical_name, p.common_names,
              CASE WHEN p.botanical_name ILIKE $1 THEN 0 ELSE 1 END AS sort_key
       FROM cambium.plants p
       ${tagSlug ? 'JOIN cambium.plant_tags pt ON pt.plant_id = p.id JOIN cambium.tags t ON t.id = pt.tag_id' : ''}
       WHERE p.is_published = true
         AND (
           p.botanical_name ILIKE $1
           OR EXISTS (
             SELECT 1 FROM unnest(p.common_names) AS cn WHERE cn ILIKE $1
           )
         )
       ${tagSlug ? 'AND t.slug = $2' : ''}
     ) sub
     ORDER BY sort_key, botanical_name
     LIMIT ${tagSlug ? '$3' : '$2'} OFFSET ${tagSlug ? '$4' : '$3'}`,
    tagSlug ? [pattern, tagSlug, limit, offset] : [pattern, limit, offset],
  );

  const ids = dataResult.rows.map((r) => BigInt(r.id));
  const tagsMap = await fetchTagsForPlants(ids);

  const data: PlantSummary[] = dataResult.rows.map((row) =>
    rowToSummary(row, tagsMap.get(row.id) ?? []),
  );

  return { data, total };
}

export async function getPlantBySlug(slug: string): Promise<PlantDetail | null> {
  const plantResult = await db.query(
    `SELECT p.id::text AS id, p.slug, p.botanical_name, p.common_names,
            p.description, p.family, p.genus, p.species, p.cultivar,
            ga.days_to_germination_min, ga.days_to_germination_max,
            ga.days_to_maturity_min, ga.days_to_maturity_max,
            ga.spacing_cm_min, ga.spacing_cm_max, ga.row_spacing_cm,
            ga.plant_height_cm_min, ga.plant_height_cm_max,
            ga.sun_requirements, ga.water_requirements,
            ga.frost_hardy, ga.direct_sow, ga.transplant,
            sp.ph_min, sp.ph_max, sp.nitrogen_demand, sp.phosphorus_demand,
            sp.potassium_demand, sp.moisture_preference, sp.drainage
     FROM cambium.plants p
     LEFT JOIN cambium.growing_attributes ga ON ga.plant_id = p.id
     LEFT JOIN cambium.soil_preferences sp ON sp.plant_id = p.id
     WHERE p.slug = $1 AND p.is_published = true`,
    [slug],
  );

  if (plantResult.rows.length === 0) return null;

  const row = plantResult.rows[0];
  const plantId = BigInt(row.id);

  const tagsMap = await fetchTagsForPlants([plantId]);
  const tags = tagsMap.get(row.id as string) ?? [];
  const companions = await getCompanions(plantId);

  const ga = rowToGrowingAttributes(row);
  const hasGa = Object.values(ga).some((v) => v !== null);

  const sp = rowToSoilPreferences(row);
  const hasSp = Object.values(sp).some((v) => v !== null);

  return {
    id: row.id as string,
    slug: row.slug as string,
    botanicalName: row.botanical_name as string,
    commonNames: (row.common_names as string[]) ?? [],
    description: (row.description as string | null) ?? null,
    family: (row.family as string | null) ?? null,
    genus: row.genus as string,
    species: row.species as string,
    cultivar: (row.cultivar as string | null) ?? null,
    tags,
    growingAttributes: hasGa ? ga : null,
    soilPreferences: hasSp ? sp : null,
    companions,
  };
}

export async function getCompanions(plantId: bigint): Promise<CompanionEntry[]> {
  const result = await db.query(
    `SELECT cd.relationship, cd.confidence, cd.notes, cd.source,
            p.id::text AS id, p.slug, p.botanical_name, p.common_names
     FROM cambium.companion_data cd
     JOIN cambium.plants p ON p.id = cd.companion_plant_id
     WHERE cd.plant_id = $1
       AND cd.confidence >= $2
       AND p.is_published = true
     ORDER BY cd.relationship, cd.confidence DESC`,
    [plantId, COMPANION_CONFIDENCE_THRESHOLD],
  );

  if (result.rows.length === 0) return [];

  const companionIds = result.rows.map((r) => BigInt(r.id));
  const tagsMap = await fetchTagsForPlants(companionIds);

  return result.rows.map((row) => ({
    plant: rowToSummary(row, tagsMap.get(row.id as string) ?? []),
    relationship: row.relationship as 'beneficial' | 'antagonistic' | 'neutral',
    confidence: row.confidence as number,
    notes: (row.notes as string | null) ?? null,
    source: (row.source as string | null) ?? null,
  }));
}

export async function listTags(): Promise<
  { slug: string; label: string; category: string | null; count: number }[]
> {
  const result = await db.query(
    `SELECT t.slug, t.label, t.category, COUNT(pt.plant_id)::int AS count
     FROM cambium.tags t
     JOIN cambium.plant_tags pt ON pt.tag_id = t.id
     JOIN cambium.plants p ON p.id = pt.plant_id AND p.is_published = true
     GROUP BY t.id, t.slug, t.label, t.category
     ORDER BY t.category NULLS LAST, t.label`,
  );
  return result.rows.map((r) => ({
    slug: r.slug as string,
    label: r.label as string,
    category: (r.category as string | null) ?? null,
    count: r.count as number,
  }));
}

export async function getCompanionsBySlug(
  slug: string,
  options?: { relationship?: 'beneficial' | 'antagonistic' | 'neutral' },
): Promise<CompanionEntry[] | null> {
  // Resolve plant ID from slug
  const plantRow = await db.query<{ id: string }>(
    'SELECT id::text AS id FROM cambium.plants WHERE slug = $1 AND is_published = true',
    [slug],
  );

  if (plantRow.rows.length === 0) return null;

  const plantId = BigInt(plantRow.rows[0].id);
  const relationshipFilter = options?.relationship;

  const result = await db.query(
    `SELECT cd.relationship, cd.confidence, cd.notes, cd.source,
            p.id::text AS id, p.slug, p.botanical_name, p.common_names
     FROM cambium.companion_data cd
     JOIN cambium.plants p ON p.id = cd.companion_plant_id
     WHERE cd.plant_id = $1
       AND cd.confidence >= $2
       AND p.is_published = true
       ${relationshipFilter ? 'AND cd.relationship = $3' : ''}
     ORDER BY cd.confidence DESC`,
    relationshipFilter
      ? [plantId, COMPANION_CONFIDENCE_THRESHOLD, relationshipFilter]
      : [plantId, COMPANION_CONFIDENCE_THRESHOLD],
  );

  if (result.rows.length === 0) return [];

  const companionIds = result.rows.map((r) => BigInt(r.id as string));
  const tagsMap = await fetchTagsForPlants(companionIds);

  return result.rows.map((row) => ({
    plant: rowToSummary(row, tagsMap.get(row.id as string) ?? []),
    relationship: row.relationship as 'beneficial' | 'antagonistic' | 'neutral',
    confidence: row.confidence as number,
    notes: (row.notes as string | null) ?? null,
    source: (row.source as string | null) ?? null,
  }));
}

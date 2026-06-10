import { Router } from 'express';
import { db } from '../lib/db';
import { requireAuth } from '../middleware/auth';

const router = Router();
router.use(requireAuth);

// ── Validation constants ──────────────────────────────────────────────────────

const VALID_SUNLIGHT = new Set(['full_sun', 'partial_shade', 'full_shade']);
const VALID_WATERING = new Set(['low', 'moderate', 'high']);
const VALID_FROST = new Set(['none', 'light', 'hard']);
const VALID_ORIGINS = new Set(['user_created', 'cambium_imported', 'cambium_linked']);

// ── Types ─────────────────────────────────────────────────────────────────────

interface SeedRow {
  id: string;
  common_name: string;
  scientific_name: string | null;
  plant_family: string | null;
  cambium_source_id: string | null;
  origin: string;
  contribution_status: string;
  spacing_inches: string | null;           // NUMERIC → string from pg
  maturity_days_min: number | null;
  maturity_days_max: number | null;
  sunlight: string | null;
  watering_needs: string | null;
  hardiness_zone_min: string | null;
  hardiness_zone_max: string | null;
  frost_tolerance: string | null;
  weeks_to_transplant: number | null;
  succession_interval_weeks: number | null;
  user_notes: string | null;
  user_rating: number | null;
  is_favourite: boolean;
  illustration_key: string | null;
  planting_depth_inches: string | null;    // NUMERIC(5,2) → string from pg
  row_spacing_inches: string | null;       // NUMERIC(6,2) → string from pg
  germination_days_min: number | null;
  germination_days_max: number | null;
  germination_temp_min_f: number | null;   // INTEGER
  germination_temp_max_f: number | null;   // INTEGER
  tags: string[];                          // TEXT[] → JS array from pg
  created_at: string;
  updated_at: string;
}

interface CambiumSeedRow {
  id: number;
  common_name: string;
  scientific_name: string | null;
  plant_family: string | null;
  spacing_inches: string | null;
  maturity_days_min: number | null;
  maturity_days_max: number | null;
  sunlight: string | null;
  watering_needs: string | null;
  hardiness_zone_min: string | null;
  hardiness_zone_max: string | null;
  frost_tolerance: string | null;
  weeks_to_transplant: number | null;
  succession_interval_weeks: number | null;
  illustration_key: string | null;
  planting_depth_inches: string | null;
  row_spacing_inches: string | null;
  germination_days_min: number | null;
  germination_days_max: number | null;
  germination_temp_min_f: number | null;
  germination_temp_max_f: number | null;
}

// ── Column list ───────────────────────────────────────────────────────────────

const SEED_SELECT = `
  id::text, common_name, scientific_name, plant_family,
  cambium_source_id::text, origin, contribution_status,
  spacing_inches, maturity_days_min, maturity_days_max,
  sunlight, watering_needs, hardiness_zone_min, hardiness_zone_max,
  frost_tolerance, weeks_to_transplant, succession_interval_weeks,
  user_notes, user_rating, is_favourite, illustration_key,
  planting_depth_inches, row_spacing_inches,
  germination_days_min, germination_days_max,
  germination_temp_min_f, germination_temp_max_f,
  tags, created_at, updated_at
`;

// ── Formatter ─────────────────────────────────────────────────────────────────

function formatSeed(row: SeedRow) {
  return {
    id: row.id,
    commonName: row.common_name,
    scientificName: row.scientific_name,
    plantFamily: row.plant_family,
    cambiumSourceId: row.cambium_source_id,
    origin: row.origin,
    contributionStatus: row.contribution_status,
    spacingInches: row.spacing_inches != null ? Number(row.spacing_inches) : null,
    maturityDaysMin: row.maturity_days_min,
    maturityDaysMax: row.maturity_days_max,
    sunlight: row.sunlight,
    wateringNeeds: row.watering_needs,
    hardinessZoneMin: row.hardiness_zone_min,
    hardinessZoneMax: row.hardiness_zone_max,
    frostTolerance: row.frost_tolerance,
    weeksToTransplant: row.weeks_to_transplant,
    successionIntervalWeeks: row.succession_interval_weeks,
    userNotes: row.user_notes,
    userRating: row.user_rating,
    isFavourite: row.is_favourite,
    illustrationKey: row.illustration_key,
    plantingDepthInches: row.planting_depth_inches != null ? Number(row.planting_depth_inches) : null,
    rowSpacingInches: row.row_spacing_inches != null ? Number(row.row_spacing_inches) : null,
    germinationDaysMin: row.germination_days_min,
    germinationDaysMax: row.germination_days_max,
    germinationTempMinF: row.germination_temp_min_f,
    germinationTempMaxF: row.germination_temp_max_f,
    tags: row.tags,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── Validation helper ─────────────────────────────────────────────────────────

function validateTags(v: unknown): string[] | string {
  if (!Array.isArray(v)) return 'tags must be an array';
  if (v.length > 20) return 'tags must contain at most 20 items';
  const result: string[] = [];
  for (const item of v) {
    if (typeof item !== 'string') return 'each tag must be a string';
    const t = item.trim();
    if (t.length === 0) return 'tags must not contain empty strings';
    if (t.length > 40) return 'each tag must be 40 characters or fewer';
    result.push(t);
  }
  return result;
}

// ── GET /api/seeds ────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  const accountId = req.session!.account!.id;

  const q = typeof req.query.q === 'string' ? req.query.q.trim() : undefined;
  const family = typeof req.query.family === 'string' ? req.query.family : undefined;
  const favourite = req.query.favourite === 'true';
  const originFilter = typeof req.query.origin === 'string' ? req.query.origin : undefined;

  if (originFilter && !VALID_ORIGINS.has(originFilter)) {
    return res
      .status(400)
      .json({ error: `origin must be one of: ${[...VALID_ORIGINS].join(', ')}` });
  }

  const rawLimit = parseInt(req.query.limit as string, 10);
  const rawOffset = parseInt(req.query.offset as string, 10);
  const limit = isNaN(rawLimit) ? 50 : Math.min(Math.max(rawLimit, 1), 100);
  const offset = isNaN(rawOffset) ? 0 : Math.max(rawOffset, 0);

  try {
    const conditions: string[] = ['owner_id = $1'];
    const params: unknown[] = [accountId];
    let idx = 2;

    if (q) {
      conditions.push(`(common_name ILIKE $${idx} OR scientific_name ILIKE $${idx})`);
      params.push(`%${q}%`);
      idx++;
    }
    if (family) {
      conditions.push(`plant_family = $${idx}`);
      params.push(family);
      idx++;
    }
    if (favourite) {
      conditions.push('is_favourite = true');
    }
    if (originFilter) {
      conditions.push(`origin = $${idx}`);
      params.push(originFilter);
      idx++;
    }

    const where = conditions.join(' AND ');

    const [countResult, dataResult] = await Promise.all([
      db.query<{ total: number }>(
        `SELECT COUNT(*)::int AS total FROM seeds WHERE ${where}`,
        params,
      ),
      db.query<SeedRow>(
        `SELECT ${SEED_SELECT} FROM seeds WHERE ${where} ORDER BY common_name ASC LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, limit, offset],
      ),
    ]);

    res.json({
      data: dataResult.rows.map(formatSeed),
      total: countResult.rows[0].total,
      limit,
      offset,
    });
  } catch (err) {
    console.error('GET /seeds error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/seeds ───────────────────────────────────────────────────────────

router.post('/', async (req, res) => {
  const accountId = req.session!.account!.id;
  const body = req.body as Record<string, unknown>;

  if (typeof body.commonName !== 'string' || body.commonName.trim().length === 0) {
    return res.status(400).json({ error: 'commonName is required' });
  }
  if (body.commonName.trim().length > 120) {
    return res.status(400).json({ error: 'commonName must be 120 characters or fewer' });
  }
  const commonName = body.commonName.trim();

  if (typeof body.plantFamily !== 'string' || body.plantFamily.trim().length === 0) {
    return res.status(400).json({ error: 'plantFamily is required' });
  }
  if (body.plantFamily.trim().length > 80) {
    return res.status(400).json({ error: 'plantFamily must be 80 characters or fewer' });
  }
  const plantFamily = body.plantFamily.trim();

  // Optional string fields
  const scientificName =
    typeof body.scientificName === 'string' ? body.scientificName.trim() || null : null;
  const userNotes =
    typeof body.userNotes === 'string' ? body.userNotes.trim() || null : null;
  const illustrationKey =
    typeof body.illustrationKey === 'string' ? body.illustrationKey.trim() || null : null;
  const hardinessZoneMin =
    typeof body.hardinessZoneMin === 'string' ? body.hardinessZoneMin.trim() || null : null;
  const hardinessZoneMax =
    typeof body.hardinessZoneMax === 'string' ? body.hardinessZoneMax.trim() || null : null;

  // Enum fields
  let sunlight: string | null = null;
  if (body.sunlight != null) {
    if (typeof body.sunlight !== 'string' || !VALID_SUNLIGHT.has(body.sunlight)) {
      return res.status(400).json({ error: `sunlight must be one of: ${[...VALID_SUNLIGHT].join(', ')}` });
    }
    sunlight = body.sunlight;
  }

  let wateringNeeds: string | null = null;
  if (body.wateringNeeds != null) {
    if (typeof body.wateringNeeds !== 'string' || !VALID_WATERING.has(body.wateringNeeds)) {
      return res.status(400).json({ error: `wateringNeeds must be one of: ${[...VALID_WATERING].join(', ')}` });
    }
    wateringNeeds = body.wateringNeeds;
  }

  let frostTolerance: string | null = null;
  if (body.frostTolerance != null) {
    if (typeof body.frostTolerance !== 'string' || !VALID_FROST.has(body.frostTolerance)) {
      return res.status(400).json({ error: `frostTolerance must be one of: ${[...VALID_FROST].join(', ')}` });
    }
    frostTolerance = body.frostTolerance;
  }

  // Positive-number NUMERIC fields
  let spacingInches: number | null = null;
  if (body.spacingInches != null) {
    if (typeof body.spacingInches !== 'number' || !isFinite(body.spacingInches) || body.spacingInches <= 0) {
      return res.status(400).json({ error: 'spacingInches must be a positive number' });
    }
    spacingInches = body.spacingInches;
  }

  let plantingDepthInches: number | null = null;
  if (body.plantingDepthInches != null) {
    if (typeof body.plantingDepthInches !== 'number' || !isFinite(body.plantingDepthInches) || body.plantingDepthInches <= 0) {
      return res.status(400).json({ error: 'plantingDepthInches must be a positive number' });
    }
    plantingDepthInches = body.plantingDepthInches;
  }

  let rowSpacingInches: number | null = null;
  if (body.rowSpacingInches != null) {
    if (typeof body.rowSpacingInches !== 'number' || !isFinite(body.rowSpacingInches) || body.rowSpacingInches <= 0) {
      return res.status(400).json({ error: 'rowSpacingInches must be a positive number' });
    }
    rowSpacingInches = body.rowSpacingInches;
  }

  // Positive-integer fields
  let weeksToTransplant: number | null = null;
  if (body.weeksToTransplant != null) {
    if (!Number.isInteger(body.weeksToTransplant) || (body.weeksToTransplant as number) <= 0) {
      return res.status(400).json({ error: 'weeksToTransplant must be a positive integer' });
    }
    weeksToTransplant = body.weeksToTransplant as number;
  }

  let successionIntervalWeeks: number | null = null;
  if (body.successionIntervalWeeks != null) {
    if (!Number.isInteger(body.successionIntervalWeeks) || (body.successionIntervalWeeks as number) <= 0) {
      return res.status(400).json({ error: 'successionIntervalWeeks must be a positive integer' });
    }
    successionIntervalWeeks = body.successionIntervalWeeks as number;
  }

  // intRange pairs
  let maturityDaysMin: number | null = null;
  if (body.maturityDaysMin != null) {
    if (!Number.isInteger(body.maturityDaysMin) || (body.maturityDaysMin as number) <= 0) {
      return res.status(400).json({ error: 'maturityDaysMin must be a positive integer' });
    }
    maturityDaysMin = body.maturityDaysMin as number;
  }
  let maturityDaysMax: number | null = null;
  if (body.maturityDaysMax != null) {
    if (!Number.isInteger(body.maturityDaysMax) || (body.maturityDaysMax as number) <= 0) {
      return res.status(400).json({ error: 'maturityDaysMax must be a positive integer' });
    }
    maturityDaysMax = body.maturityDaysMax as number;
  }
  if (maturityDaysMin !== null && maturityDaysMax !== null && maturityDaysMin > maturityDaysMax) {
    return res.status(400).json({ error: 'maturityDaysMin must be <= maturityDaysMax' });
  }

  let germinationDaysMin: number | null = null;
  if (body.germinationDaysMin != null) {
    if (!Number.isInteger(body.germinationDaysMin) || (body.germinationDaysMin as number) <= 0) {
      return res.status(400).json({ error: 'germinationDaysMin must be a positive integer' });
    }
    germinationDaysMin = body.germinationDaysMin as number;
  }
  let germinationDaysMax: number | null = null;
  if (body.germinationDaysMax != null) {
    if (!Number.isInteger(body.germinationDaysMax) || (body.germinationDaysMax as number) <= 0) {
      return res.status(400).json({ error: 'germinationDaysMax must be a positive integer' });
    }
    germinationDaysMax = body.germinationDaysMax as number;
  }
  if (germinationDaysMin !== null && germinationDaysMax !== null && germinationDaysMin > germinationDaysMax) {
    return res.status(400).json({ error: 'germinationDaysMin must be <= germinationDaysMax' });
  }

  let germinationTempMinF: number | null = null;
  if (body.germinationTempMinF != null) {
    if (!Number.isInteger(body.germinationTempMinF) || (body.germinationTempMinF as number) <= 0) {
      return res.status(400).json({ error: 'germinationTempMinF must be a positive integer' });
    }
    germinationTempMinF = body.germinationTempMinF as number;
  }
  let germinationTempMaxF: number | null = null;
  if (body.germinationTempMaxF != null) {
    if (!Number.isInteger(body.germinationTempMaxF) || (body.germinationTempMaxF as number) <= 0) {
      return res.status(400).json({ error: 'germinationTempMaxF must be a positive integer' });
    }
    germinationTempMaxF = body.germinationTempMaxF as number;
  }
  if (germinationTempMinF !== null && germinationTempMaxF !== null && germinationTempMinF > germinationTempMaxF) {
    return res.status(400).json({ error: 'germinationTempMinF must be <= germinationTempMaxF' });
  }

  // userRating
  let userRating: number | null = null;
  if (body.userRating != null) {
    if (!Number.isInteger(body.userRating) || (body.userRating as number) < 1 || (body.userRating as number) > 5) {
      return res.status(400).json({ error: 'userRating must be between 1 and 5' });
    }
    userRating = body.userRating as number;
  }

  // isFavourite
  const isFavourite = typeof body.isFavourite === 'boolean' ? body.isFavourite : false;

  // tags
  let tags: string[] = [];
  if (body.tags !== undefined) {
    const tagsResult = validateTags(body.tags);
    if (typeof tagsResult === 'string') return res.status(400).json({ error: tagsResult });
    tags = tagsResult;
  }

  try {
    const result = await db.query<SeedRow>(
      `INSERT INTO seeds (
         owner_id, common_name, scientific_name, plant_family,
         origin, contribution_status,
         spacing_inches, maturity_days_min, maturity_days_max,
         sunlight, watering_needs, hardiness_zone_min, hardiness_zone_max,
         frost_tolerance, weeks_to_transplant, succession_interval_weeks,
         user_notes, user_rating, is_favourite, illustration_key,
         planting_depth_inches, row_spacing_inches,
         germination_days_min, germination_days_max,
         germination_temp_min_f, germination_temp_max_f,
         tags
       ) VALUES (
         $1, $2, $3, $4, 'user_created', 'private',
         $5, $6, $7, $8, $9, $10, $11,
         $12, $13, $14, $15, $16, $17, $18,
         $19, $20, $21, $22, $23, $24, $25
       )
       RETURNING ${SEED_SELECT}`,
      [
        accountId, commonName, scientificName, plantFamily,
        spacingInches, maturityDaysMin, maturityDaysMax,
        sunlight, wateringNeeds, hardinessZoneMin, hardinessZoneMax,
        frostTolerance, weeksToTransplant, successionIntervalWeeks,
        userNotes, userRating, isFavourite, illustrationKey,
        plantingDepthInches, rowSpacingInches,
        germinationDaysMin, germinationDaysMax,
        germinationTempMinF, germinationTempMaxF,
        tags,
      ],
    );
    res.status(201).json(formatSeed(result.rows[0]));
  } catch (err) {
    console.error('POST /seeds error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/seeds/add-from-cambium  (must be before /:id routes) ────────────

router.post('/add-from-cambium', async (req, res) => {
  const accountId = req.session!.account!.id;
  const body = req.body as Record<string, unknown>;

  const rawId = body.cambiumSeedId;
  if (rawId === undefined || rawId === null) {
    return res.status(400).json({ error: 'cambiumSeedId is required' });
  }
  const cambiumSeedIdStr = String(rawId);
  if (!/^\d+$/.test(cambiumSeedIdStr)) {
    return res.status(400).json({ error: 'cambiumSeedId must be a numeric id' });
  }

  try {
    const sourceResult = await db.query<CambiumSeedRow>(
      `SELECT id, common_name, scientific_name, plant_family,
              spacing_inches, maturity_days_min, maturity_days_max,
              sunlight, watering_needs, hardiness_zone_min, hardiness_zone_max,
              frost_tolerance, weeks_to_transplant, succession_interval_weeks,
              illustration_key,
              planting_depth_inches, row_spacing_inches,
              germination_days_min, germination_days_max,
              germination_temp_min_f, germination_temp_max_f
       FROM cambium.seeds
       WHERE id = $1 AND moderation_status = 'active'`,
      [cambiumSeedIdStr],
    );
    if (sourceResult.rows.length === 0) {
      return res.status(400).json({ error: 'Cambium seed not found or not active' });
    }
    const src = sourceResult.rows[0];

    const dupResult = await db.query<{ id: string }>(
      'SELECT id::text FROM seeds WHERE owner_id = $1 AND cambium_source_id = $2',
      [accountId, cambiumSeedIdStr],
    );
    if (dupResult.rows.length > 0) {
      return res.status(409).json({ alreadyInCatalogue: true, seedId: dupResult.rows[0].id });
    }

    const result = await db.query<SeedRow>(
      `INSERT INTO seeds (
         owner_id, common_name, scientific_name, plant_family,
         origin, contribution_status, cambium_source_id,
         spacing_inches, maturity_days_min, maturity_days_max,
         sunlight, watering_needs, hardiness_zone_min, hardiness_zone_max,
         frost_tolerance, weeks_to_transplant, succession_interval_weeks,
         illustration_key,
         planting_depth_inches, row_spacing_inches,
         germination_days_min, germination_days_max,
         germination_temp_min_f, germination_temp_max_f
       ) VALUES (
         $1, $2, $3, $4, 'cambium_imported', 'private', $5,
         $6, $7, $8, $9, $10, $11, $12,
         $13, $14, $15, $16,
         $17, $18, $19, $20, $21, $22
       )
       RETURNING ${SEED_SELECT}`,
      [
        accountId, src.common_name, src.scientific_name, src.plant_family,
        cambiumSeedIdStr,
        src.spacing_inches, src.maturity_days_min, src.maturity_days_max,
        src.sunlight, src.watering_needs, src.hardiness_zone_min, src.hardiness_zone_max,
        src.frost_tolerance, src.weeks_to_transplant, src.succession_interval_weeks,
        src.illustration_key,
        src.planting_depth_inches, src.row_spacing_inches,
        src.germination_days_min, src.germination_days_max,
        src.germination_temp_min_f, src.germination_temp_max_f,
      ],
    );

    res.status(201).json(formatSeed(result.rows[0]));
  } catch (err) {
    console.error('POST /seeds/add-from-cambium error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/seeds/:id ────────────────────────────────────────────────────────

router.get('/:id', async (req, res) => {
  const accountId = req.session!.account!.id;
  const seedId = req.params.id as string;

  if (!/^\d+$/.test(seedId)) return res.status(400).json({ error: 'Invalid id' });

  try {
    const seedResult = await db.query<SeedRow>(
      `SELECT ${SEED_SELECT} FROM seeds WHERE id = $1 AND owner_id = $2`,
      [seedId, accountId],
    );
    if (seedResult.rows.length === 0) {
      return res.status(404).json({ error: 'Seed not found' });
    }

    const historyResult = await db.query<{
      planting_id: string;
      garden_id: string;
      garden_name: string;
      bed_id: string;
      bed_label: string;
      season: number;
      harvest_logged: boolean;
    }>(
      `SELECT p.id::text AS planting_id, g.id::text AS garden_id, g.name AS garden_name,
              b.id::text AS bed_id, b.label AS bed_label, p.season,
              EXISTS (
                SELECT 1 FROM sowing_events se
                JOIN harvest_entries he ON he.sowing_event_id = se.id
                WHERE se.planting_id = p.id
              ) AS harvest_logged
       FROM plantings p
       JOIN gardens g ON g.id = p.garden_id
       JOIN beds b ON b.id = p.bed_id
       WHERE p.seed_id = $1
       ORDER BY p.season DESC, p.created_at DESC`,
      [seedId],
    );

    res.json({
      ...formatSeed(seedResult.rows[0]),
      plantingHistory: historyResult.rows.map((r) => ({
        plantingId: r.planting_id,
        gardenId: r.garden_id,
        gardenName: r.garden_name,
        bedId: r.bed_id,
        bedLabel: r.bed_label,
        season: r.season,
        harvestLogged: r.harvest_logged,
      })),
    });
  } catch (err) {
    console.error('GET /seeds/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── PATCH /api/seeds/:id ──────────────────────────────────────────────────────

router.patch('/:id', async (req, res) => {
  const accountId = req.session!.account!.id;
  const seedId = req.params.id as string;

  if (!/^\d+$/.test(seedId)) return res.status(400).json({ error: 'Invalid id' });

  const body = req.body as Record<string, unknown>;

  if (body.origin !== undefined) {
    return res.status(400).json({ error: 'origin cannot be changed' });
  }
  if (body.cambiumSourceId !== undefined) {
    return res.status(400).json({ error: 'cambiumSourceId cannot be changed' });
  }
  if (body.contributionStatus !== undefined) {
    return res.status(400).json({ error: 'contributionStatus cannot be changed' });
  }

  try {
    const existing = await db.query(
      'SELECT id FROM seeds WHERE id = $1 AND owner_id = $2',
      [seedId, accountId],
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Seed not found' });
    }

    const updates: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (body.commonName !== undefined) {
      if (typeof body.commonName !== 'string' || body.commonName.trim().length === 0) {
        return res.status(400).json({ error: 'commonName cannot be empty' });
      }
      if (body.commonName.trim().length > 120) {
        return res.status(400).json({ error: 'commonName must be 120 characters or fewer' });
      }
      updates.push(`common_name = $${idx++}`);
      values.push(body.commonName.trim());
    }

    if (body.scientificName !== undefined) {
      updates.push(`scientific_name = $${idx++}`);
      values.push(typeof body.scientificName === 'string' ? body.scientificName.trim() || null : null);
    }

    if (body.plantFamily !== undefined) {
      if (typeof body.plantFamily !== 'string' || body.plantFamily.trim().length === 0) {
        return res.status(400).json({ error: 'plantFamily cannot be empty' });
      }
      if (body.plantFamily.trim().length > 80) {
        return res.status(400).json({ error: 'plantFamily must be 80 characters or fewer' });
      }
      updates.push(`plant_family = $${idx++}`);
      values.push(body.plantFamily.trim());
    }

    if (body.spacingInches !== undefined) {
      if (body.spacingInches !== null) {
        if (typeof body.spacingInches !== 'number' || !isFinite(body.spacingInches) || body.spacingInches <= 0) {
          return res.status(400).json({ error: 'spacingInches must be a positive number' });
        }
      }
      updates.push(`spacing_inches = $${idx++}`);
      values.push(body.spacingInches);
    }

    if (body.plantingDepthInches !== undefined) {
      if (body.plantingDepthInches !== null) {
        if (typeof body.plantingDepthInches !== 'number' || !isFinite(body.plantingDepthInches) || body.plantingDepthInches <= 0) {
          return res.status(400).json({ error: 'plantingDepthInches must be a positive number' });
        }
      }
      updates.push(`planting_depth_inches = $${idx++}`);
      values.push(body.plantingDepthInches);
    }

    if (body.rowSpacingInches !== undefined) {
      if (body.rowSpacingInches !== null) {
        if (typeof body.rowSpacingInches !== 'number' || !isFinite(body.rowSpacingInches) || body.rowSpacingInches <= 0) {
          return res.status(400).json({ error: 'rowSpacingInches must be a positive number' });
        }
      }
      updates.push(`row_spacing_inches = $${idx++}`);
      values.push(body.rowSpacingInches);
    }

    if (body.maturityDaysMin !== undefined) {
      if (body.maturityDaysMin !== null && (!Number.isInteger(body.maturityDaysMin) || (body.maturityDaysMin as number) <= 0)) {
        return res.status(400).json({ error: 'maturityDaysMin must be a positive integer' });
      }
      updates.push(`maturity_days_min = $${idx++}`);
      values.push(body.maturityDaysMin);
    }

    if (body.maturityDaysMax !== undefined) {
      if (body.maturityDaysMax !== null && (!Number.isInteger(body.maturityDaysMax) || (body.maturityDaysMax as number) <= 0)) {
        return res.status(400).json({ error: 'maturityDaysMax must be a positive integer' });
      }
      updates.push(`maturity_days_max = $${idx++}`);
      values.push(body.maturityDaysMax);
    }

    if (
      body.maturityDaysMin !== undefined && body.maturityDaysMax !== undefined &&
      body.maturityDaysMin !== null && body.maturityDaysMax !== null &&
      (body.maturityDaysMin as number) > (body.maturityDaysMax as number)
    ) {
      return res.status(400).json({ error: 'maturityDaysMin must be <= maturityDaysMax' });
    }

    if (body.germinationDaysMin !== undefined) {
      if (body.germinationDaysMin !== null && (!Number.isInteger(body.germinationDaysMin) || (body.germinationDaysMin as number) <= 0)) {
        return res.status(400).json({ error: 'germinationDaysMin must be a positive integer' });
      }
      updates.push(`germination_days_min = $${idx++}`);
      values.push(body.germinationDaysMin);
    }

    if (body.germinationDaysMax !== undefined) {
      if (body.germinationDaysMax !== null && (!Number.isInteger(body.germinationDaysMax) || (body.germinationDaysMax as number) <= 0)) {
        return res.status(400).json({ error: 'germinationDaysMax must be a positive integer' });
      }
      updates.push(`germination_days_max = $${idx++}`);
      values.push(body.germinationDaysMax);
    }

    if (
      body.germinationDaysMin !== undefined && body.germinationDaysMax !== undefined &&
      body.germinationDaysMin !== null && body.germinationDaysMax !== null &&
      (body.germinationDaysMin as number) > (body.germinationDaysMax as number)
    ) {
      return res.status(400).json({ error: 'germinationDaysMin must be <= germinationDaysMax' });
    }

    if (body.germinationTempMinF !== undefined) {
      if (body.germinationTempMinF !== null && (!Number.isInteger(body.germinationTempMinF) || (body.germinationTempMinF as number) <= 0)) {
        return res.status(400).json({ error: 'germinationTempMinF must be a positive integer' });
      }
      updates.push(`germination_temp_min_f = $${idx++}`);
      values.push(body.germinationTempMinF);
    }

    if (body.germinationTempMaxF !== undefined) {
      if (body.germinationTempMaxF !== null && (!Number.isInteger(body.germinationTempMaxF) || (body.germinationTempMaxF as number) <= 0)) {
        return res.status(400).json({ error: 'germinationTempMaxF must be a positive integer' });
      }
      updates.push(`germination_temp_max_f = $${idx++}`);
      values.push(body.germinationTempMaxF);
    }

    if (
      body.germinationTempMinF !== undefined && body.germinationTempMaxF !== undefined &&
      body.germinationTempMinF !== null && body.germinationTempMaxF !== null &&
      (body.germinationTempMinF as number) > (body.germinationTempMaxF as number)
    ) {
      return res.status(400).json({ error: 'germinationTempMinF must be <= germinationTempMaxF' });
    }

    if (body.sunlight !== undefined) {
      if (body.sunlight !== null && (typeof body.sunlight !== 'string' || !VALID_SUNLIGHT.has(body.sunlight))) {
        return res.status(400).json({ error: `sunlight must be one of: ${[...VALID_SUNLIGHT].join(', ')}` });
      }
      updates.push(`sunlight = $${idx++}`);
      values.push(body.sunlight);
    }

    if (body.wateringNeeds !== undefined) {
      if (body.wateringNeeds !== null && (typeof body.wateringNeeds !== 'string' || !VALID_WATERING.has(body.wateringNeeds))) {
        return res.status(400).json({ error: `wateringNeeds must be one of: ${[...VALID_WATERING].join(', ')}` });
      }
      updates.push(`watering_needs = $${idx++}`);
      values.push(body.wateringNeeds);
    }

    if (body.frostTolerance !== undefined) {
      if (body.frostTolerance !== null && (typeof body.frostTolerance !== 'string' || !VALID_FROST.has(body.frostTolerance))) {
        return res.status(400).json({ error: `frostTolerance must be one of: ${[...VALID_FROST].join(', ')}` });
      }
      updates.push(`frost_tolerance = $${idx++}`);
      values.push(body.frostTolerance);
    }

    if (body.hardinessZoneMin !== undefined) {
      updates.push(`hardiness_zone_min = $${idx++}`);
      values.push(typeof body.hardinessZoneMin === 'string' ? body.hardinessZoneMin.trim() || null : null);
    }

    if (body.hardinessZoneMax !== undefined) {
      updates.push(`hardiness_zone_max = $${idx++}`);
      values.push(typeof body.hardinessZoneMax === 'string' ? body.hardinessZoneMax.trim() || null : null);
    }

    if (body.weeksToTransplant !== undefined) {
      if (body.weeksToTransplant !== null && (!Number.isInteger(body.weeksToTransplant) || (body.weeksToTransplant as number) <= 0)) {
        return res.status(400).json({ error: 'weeksToTransplant must be a positive integer' });
      }
      updates.push(`weeks_to_transplant = $${idx++}`);
      values.push(body.weeksToTransplant);
    }

    if (body.successionIntervalWeeks !== undefined) {
      if (body.successionIntervalWeeks !== null && (!Number.isInteger(body.successionIntervalWeeks) || (body.successionIntervalWeeks as number) <= 0)) {
        return res.status(400).json({ error: 'successionIntervalWeeks must be a positive integer' });
      }
      updates.push(`succession_interval_weeks = $${idx++}`);
      values.push(body.successionIntervalWeeks);
    }

    if (body.userNotes !== undefined) {
      updates.push(`user_notes = $${idx++}`);
      values.push(typeof body.userNotes === 'string' ? body.userNotes.trim() || null : null);
    }

    if (body.userRating !== undefined) {
      if (body.userRating !== null && (!Number.isInteger(body.userRating) || (body.userRating as number) < 1 || (body.userRating as number) > 5)) {
        return res.status(400).json({ error: 'userRating must be between 1 and 5' });
      }
      updates.push(`user_rating = $${idx++}`);
      values.push(body.userRating);
    }

    if (body.isFavourite !== undefined) {
      if (typeof body.isFavourite !== 'boolean') {
        return res.status(400).json({ error: 'isFavourite must be a boolean' });
      }
      updates.push(`is_favourite = $${idx++}`);
      values.push(body.isFavourite);
    }

    if (body.illustrationKey !== undefined) {
      updates.push(`illustration_key = $${idx++}`);
      values.push(typeof body.illustrationKey === 'string' ? body.illustrationKey.trim() || null : null);
    }

    if (body.tags !== undefined) {
      const tagsResult = validateTags(body.tags);
      if (typeof tagsResult === 'string') return res.status(400).json({ error: tagsResult });
      updates.push(`tags = $${idx++}`);
      values.push(tagsResult);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    updates.push('updated_at = NOW()');
    values.push(seedId);

    const result = await db.query<SeedRow>(
      `UPDATE seeds SET ${updates.join(', ')} WHERE id = $${idx} RETURNING ${SEED_SELECT}`,
      values,
    );
    res.json(formatSeed(result.rows[0]));
  } catch (err) {
    console.error('PATCH /seeds/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── DELETE /api/seeds/:id ─────────────────────────────────────────────────────

router.delete('/:id', async (req, res) => {
  const accountId = req.session!.account!.id;
  const seedId = req.params.id as string;

  if (!/^\d+$/.test(seedId)) return res.status(400).json({ error: 'Invalid id' });

  try {
    const existing = await db.query(
      'SELECT id FROM seeds WHERE id = $1 AND owner_id = $2',
      [seedId, accountId],
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Seed not found' });
    }

    const countResult = await db.query<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM plantings WHERE seed_id = $1',
      [seedId],
    );
    if (countResult.rows[0].count > 0) {
      return res.status(409).json({
        error: 'This seed is planted in your gardens — remove those plantings first',
        plantingCount: countResult.rows[0].count,
      });
    }

    await db.query('DELETE FROM seeds WHERE id = $1', [seedId]);
    res.status(204).send();
  } catch (err) {
    console.error('DELETE /seeds/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/seeds/:id/contribute ───────────────────────────────────────────

router.post('/:id/contribute', async (req, res) => {
  const accountId = req.session!.account!.id;
  const seedId = req.params.id as string;

  if (!/^\d+$/.test(seedId)) return res.status(400).json({ error: 'Invalid id' });

  try {
    const seedResult = await db.query<SeedRow>(
      `SELECT ${SEED_SELECT} FROM seeds WHERE id = $1 AND owner_id = $2`,
      [seedId, accountId],
    );
    if (seedResult.rows.length === 0) {
      return res.status(404).json({ error: 'Seed not found' });
    }

    const seed = seedResult.rows[0];

    if (seed.origin !== 'user_created') {
      return res.status(400).json({ error: 'Imported seeds cannot be contributed back' });
    }
    if (seed.contribution_status !== 'private' && seed.contribution_status !== 'rejected') {
      return res.status(400).json({ error: 'Seed contribution is already pending or approved' });
    }

    const snapshot = { ...formatSeed(seed), includePhotos: !!(req.body as Record<string, unknown>).includePhotos };

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO moderation_items (type, seed_id, submitted_by, content)
         VALUES ('new_seed', $1, $2, $3)`,
        [seedId, accountId, JSON.stringify(snapshot)],
      );
      await client.query(
        `UPDATE seeds SET contribution_status = 'pending', updated_at = NOW() WHERE id = $1`,
        [seedId],
      );
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }

    res.json({ contributionStatus: 'pending' });
  } catch (err) {
    console.error('POST /seeds/:id/contribute error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;

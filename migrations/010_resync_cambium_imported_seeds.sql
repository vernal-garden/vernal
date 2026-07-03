-- 010_resync_cambium_imported_seeds.sql
-- One-time re-sync: personal seeds imported from cambium before the importer
-- copied growing fields. Any cambium_imported row with at least one null core
-- field gets its nulls filled from cambium.seeds. Non-null values are left
-- untouched (COALESCE preserves existing data and only fills gaps).

BEGIN;

UPDATE seeds s
SET
    scientific_name           = COALESCE(s.scientific_name,           cs.scientific_name),
    plant_family              = COALESCE(s.plant_family,              cs.plant_family),
    spacing_inches            = COALESCE(s.spacing_inches,            cs.spacing_inches),
    maturity_days_min         = COALESCE(s.maturity_days_min,         cs.maturity_days_min),
    maturity_days_max         = COALESCE(s.maturity_days_max,         cs.maturity_days_max),
    sunlight                  = COALESCE(s.sunlight,                  cs.sunlight),
    watering_needs            = COALESCE(s.watering_needs,            cs.watering_needs),
    hardiness_zone_min        = COALESCE(s.hardiness_zone_min,        cs.hardiness_zone_min),
    hardiness_zone_max        = COALESCE(s.hardiness_zone_max,        cs.hardiness_zone_max),
    frost_tolerance           = COALESCE(s.frost_tolerance,           cs.frost_tolerance),
    weeks_to_transplant       = COALESCE(s.weeks_to_transplant,       cs.weeks_to_transplant),
    succession_interval_weeks = COALESCE(s.succession_interval_weeks, cs.succession_interval_weeks),
    illustration_key          = COALESCE(s.illustration_key,          cs.illustration_key),
    updated_at                = NOW()
FROM cambium.seeds cs
WHERE s.cambium_source_id = cs.id
  AND s.origin = 'cambium_imported'
  AND (
       s.scientific_name           IS NULL
    OR s.plant_family              IS NULL
    OR s.spacing_inches            IS NULL
    OR s.maturity_days_min         IS NULL
    OR s.maturity_days_max         IS NULL
    OR s.sunlight                  IS NULL
    OR s.watering_needs            IS NULL
    OR s.hardiness_zone_min        IS NULL
    OR s.hardiness_zone_max        IS NULL
    OR s.frost_tolerance           IS NULL
    OR s.weeks_to_transplant       IS NULL
    OR s.succession_interval_weeks IS NULL
    OR s.illustration_key          IS NULL
  );

COMMIT;

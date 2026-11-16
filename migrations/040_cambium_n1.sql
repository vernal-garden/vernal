-- 040_cambium_n1.sql
-- Phase 68 (Cambium N1): schema support for the expanded seed catalogue.
-- in_row_spacing_inches is the distance between plants within a row, kept
-- alongside row_spacing_inches (distance between rows). A new frost level
-- 'warm' marks very tender crops that need warm soil. cambium.seeds gains the
-- value CHECKs public.seeds has had since 001 (NULL still passes). Companion
-- rows gain a status so the import can hold a pair without deleting it; only
-- 'active' rows are read. All additive: the previous release ignores the new
-- columns, never writes 'warm', and reads held companions as before.

BEGIN;

ALTER TABLE cambium.seeds
  ADD COLUMN in_row_spacing_inches NUMERIC(6,2);

ALTER TABLE seeds
  ADD COLUMN in_row_spacing_inches NUMERIC(6,2);

-- public.seeds: the 001 frost_tolerance CHECK is unnamed inline; look up its
-- generated name and replace it with a named one that allows 'warm'.
DO $$
DECLARE
  con_name TEXT;
BEGIN
  FOR con_name IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'public.seeds'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%frost_tolerance%'
  LOOP
    EXECUTE format('ALTER TABLE public.seeds DROP CONSTRAINT %I', con_name);
  END LOOP;
END $$;

ALTER TABLE seeds
  ADD CONSTRAINT seeds_frost_tolerance_check
  CHECK (frost_tolerance IN ('none', 'light', 'hard', 'warm'));

ALTER TABLE cambium.seeds
  ADD CONSTRAINT cambium_seeds_sunlight_check
    CHECK (sunlight IN ('full_sun', 'partial_shade', 'full_shade')),
  ADD CONSTRAINT cambium_seeds_watering_needs_check
    CHECK (watering_needs IN ('low', 'moderate', 'high')),
  ADD CONSTRAINT cambium_seeds_frost_tolerance_check
    CHECK (frost_tolerance IN ('none', 'light', 'hard', 'warm'));

ALTER TABLE cambium.companions
  ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'held'));

COMMIT;

-- 009_seed_growing_fields.sql
-- Field parity with the approved Seed Catalogue surfaces (4.2/4.4): the form
-- and detail view include growing fields no table had (Option A, Robert
-- 2026-06-05). Units: inches / °F per the existing spacing_inches convention.
-- tags is personal-catalogue-only (free-text chips; NOT the dropped 004 tag
-- system). Maturity deliberately stays a single range — see Phase 13.8 note.

BEGIN;

ALTER TABLE seeds
  ADD COLUMN planting_depth_inches  NUMERIC(5,2),
  ADD COLUMN row_spacing_inches     NUMERIC(6,2),
  ADD COLUMN germination_days_min   INTEGER,
  ADD COLUMN germination_days_max   INTEGER,
  ADD COLUMN germination_temp_min_f INTEGER,
  ADD COLUMN germination_temp_max_f INTEGER,
  ADD COLUMN tags                   TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE cambium.seeds
  ADD COLUMN planting_depth_inches  NUMERIC(5,2),
  ADD COLUMN row_spacing_inches     NUMERIC(6,2),
  ADD COLUMN germination_days_min   INTEGER,
  ADD COLUMN germination_days_max   INTEGER,
  ADD COLUMN germination_temp_min_f INTEGER,
  ADD COLUMN germination_temp_max_f INTEGER;

COMMIT;

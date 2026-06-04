-- 006: Drop garden_beds table
-- The canvas-native bed entity is `beds` (defined in 001_initial_schema.sql).
-- Routes have been updated to target the beds table directly.

DROP TABLE IF EXISTS garden_beds;

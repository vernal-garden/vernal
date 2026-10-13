-- 014_harvest_entries_bed.sql
-- Harvest Log spec (6.2/6.3) records an optional bed; 001 had no column for it.
BEGIN;
ALTER TABLE harvest_entries
  ADD COLUMN bed_id INTEGER REFERENCES beds(id) ON DELETE SET NULL;
CREATE INDEX harvest_entries_bed_id_idx
  ON harvest_entries (bed_id) WHERE bed_id IS NOT NULL;
COMMIT;

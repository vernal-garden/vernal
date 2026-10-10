-- 012_seed_photos.sql
-- Phase 40: seed_photos exists since 001. Store the R2 key beside the URL so
-- deletes never parse URLs. The table is empty (Robert, 2026-10-09).
BEGIN;
ALTER TABLE seed_photos
  ADD COLUMN r2_key TEXT NOT NULL UNIQUE;
CREATE INDEX seed_photos_seed_id_idx ON seed_photos (seed_id);
COMMIT;

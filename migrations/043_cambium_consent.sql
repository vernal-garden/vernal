-- 043_cambium_consent.sql
-- Records which Cambium consent line version a contributor or corrector agreed
-- to, and when. Rows created before this migration stay NULL (no backfill) and
-- cannot be approved.
BEGIN;

ALTER TABLE moderation_items
  ADD COLUMN consent_version TEXT,
  ADD COLUMN consent_at TIMESTAMPTZ;

COMMIT;

-- 022_moderation_dedupe.sql
-- One open moderation item per (submitter, cambium seed) correction and per
-- contributed seed, so a script can't flood the review queue with copies.
BEGIN;

CREATE UNIQUE INDEX moderation_items_open_correction_uniq
  ON moderation_items (submitted_by, cambium_seed_id)
  WHERE type = 'correction' AND status IN ('new', 'under_review');

CREATE UNIQUE INDEX moderation_items_open_new_seed_uniq
  ON moderation_items (seed_id)
  WHERE type = 'new_seed' AND status IN ('new', 'under_review');

COMMIT;

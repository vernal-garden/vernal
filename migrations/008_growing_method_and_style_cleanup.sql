-- UX Onboarding Amendment 1 (Q61–Q63)
-- Adds growing_method to gardens; retires 'mixed' as a valid style value.

BEGIN;

ALTER TABLE gardens
  ADD COLUMN IF NOT EXISTS growing_method TEXT NOT NULL DEFAULT 'in_ground'
    CHECK (growing_method IN ('square_foot', 'container', 'raised_bed', 'in_ground'));

-- Retire 'mixed' from the style enum.
-- PostgreSQL auto-names the inline CHECK from migration 001 as gardens_style_check.
ALTER TABLE gardens DROP CONSTRAINT IF EXISTS gardens_style_check;
ALTER TABLE gardens ADD CONSTRAINT gardens_style_check CHECK (style IN ('grid', 'freeform'));

COMMIT;

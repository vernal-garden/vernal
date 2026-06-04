-- Phase 11 — Garden & Bed CRUD
-- Adds description and zone_location_label to gardens (missing from initial schema).
-- Creates garden_beds table with the Phase 11 API shape.
-- Note: the canvas `beds` table (grid/freeform cells) is a separate entity and is
-- not touched by this migration.

BEGIN;

ALTER TABLE gardens
  ADD COLUMN IF NOT EXISTS description        TEXT,
  ADD COLUMN IF NOT EXISTS zone_location_label TEXT;

CREATE TABLE garden_beds (
  id         SERIAL      PRIMARY KEY,
  garden_id  INTEGER     NOT NULL REFERENCES gardens(id) ON DELETE CASCADE,
  name       TEXT        NOT NULL,
  bed_type   TEXT        NOT NULL DEFAULT 'raised_bed'
             CHECK (bed_type IN ('raised_bed', 'row', 'container', 'in_ground', 'vertical')),
  width_cm   NUMERIC,
  length_cm  NUMERIC,
  depth_cm   NUMERIC,
  notes      TEXT,
  sort_order INTEGER     NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX garden_beds_garden_id_idx ON garden_beds (garden_id);

COMMIT;

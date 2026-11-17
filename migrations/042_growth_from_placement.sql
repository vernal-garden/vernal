-- 042_growth_from_placement.sql
-- Phase 70 (growth from placement): placing a plant sows it. Every planting
-- gets a start method and existing plantings get a planting date, and the current season's sowing
-- events are marked done from the plantings' dates, so growth no longer waits
-- on the Planting Guide "done" step.
--
-- Seed key throughout: seed_id when the planting has one, else a Cambium-only
-- row (seed_id IS NULL AND cambium_seed_id = X), as in src/jobs/nightly.ts
-- deriveGrowth and src/routes/plantingGuide.ts seedKeyWhere.

BEGIN;

-- 1. How the plant started. Existing rows were all sown.
ALTER TABLE plantings
  ADD COLUMN start_method TEXT NOT NULL DEFAULT 'sown'
    CHECK (start_method IN ('sown', 'transplanted'));

-- 2. Backfill missing planting dates: the Pacific date of the earliest done
-- sowing event for the planting's garden, seed and season, else the Pacific
-- date the planting was created.
UPDATE plantings p
SET planting_date = COALESCE(
      (SELECT (MIN(se.marked_done_at) AT TIME ZONE 'America/Los_Angeles')::date
       FROM sowing_events se
       WHERE se.garden_id = p.garden_id
         AND se.season = p.season
         AND se.marked_done_at IS NOT NULL
         AND CASE WHEN p.seed_id IS NOT NULL THEN se.seed_id = p.seed_id
                  ELSE se.seed_id IS NULL AND se.cambium_seed_id = p.cambium_seed_id END),
      (p.created_at AT TIME ZONE 'America/Los_Angeles')::date)
WHERE p.planting_date IS NULL;

-- planting_date stays nullable for now: the previous release still inserts
-- NULL when no date is sent, so SET NOT NULL waits for the next release.

-- 3. Current season only: mark each (garden, seed) sowing event done at noon
-- Pacific on its earliest planting date. The guide reads the lowest-id event
-- for a key, so that is the one updated; keys with no event get one, shaped
-- like the guide's PUT /done insert. Past seasons are left alone.
CREATE TEMP TABLE growth_keys ON COMMIT DROP AS
SELECT p.garden_id,
       p.seed_id,
       CASE WHEN p.seed_id IS NULL THEN p.cambium_seed_id END AS cambium_seed_id,
       p.season,
       MIN(p.planting_date) AS first_date,
       MIN(p.id)            AS first_planting_id
FROM plantings p
WHERE p.season = EXTRACT(year FROM now() AT TIME ZONE 'America/Los_Angeles')::int
GROUP BY p.garden_id, p.seed_id, CASE WHEN p.seed_id IS NULL THEN p.cambium_seed_id END, p.season;

UPDATE sowing_events se
SET marked_done_at = (k.first_date + time '12:00') AT TIME ZONE 'America/Los_Angeles'
FROM growth_keys k
WHERE se.id = (
  SELECT MIN(e.id)
  FROM sowing_events e
  WHERE e.garden_id = k.garden_id
    AND e.season = k.season
    AND CASE WHEN k.seed_id IS NOT NULL THEN e.seed_id = k.seed_id
             ELSE e.seed_id IS NULL AND e.cambium_seed_id = k.cambium_seed_id END
);

INSERT INTO sowing_events
  (planting_id, garden_id, seed_id, cambium_seed_id, season, marked_done_at)
SELECT k.first_planting_id,
       k.garden_id,
       k.seed_id,
       k.cambium_seed_id,
       k.season,
       (k.first_date + time '12:00') AT TIME ZONE 'America/Los_Angeles'
FROM growth_keys k
WHERE NOT EXISTS (
  SELECT 1
  FROM sowing_events e
  WHERE e.garden_id = k.garden_id
    AND e.season = k.season
    AND CASE WHEN k.seed_id IS NOT NULL THEN e.seed_id = k.seed_id
             ELSE e.seed_id IS NULL AND e.cambium_seed_id = k.cambium_seed_id END
);

COMMIT;

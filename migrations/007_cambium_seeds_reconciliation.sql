-- 007_cambium_seeds_reconciliation.sql
-- Decision record 2026-06-04: cambium.seeds is the canonical catalogue entity.
-- The cambium.plants knowledge graph (created by 004 against an off-spec phase
-- note) is dropped. Its directional companion model — the one piece better than
-- the original design — is retained as cambium.companions, re-keyed to seeds.
-- companion_pairs (symmetric, binary, no confidence) is superseded and dropped.
-- cambium.seed_ratings is NOT touched — it keys to cambium.seeds and stays.
--
-- PRE-FLIGHT (run by hand before applying in prod):
--   SELECT COUNT(*) FROM cambium.plants;          -- expect 12 (dev starter) or 0
--   SELECT COUNT(*) FROM cambium.companion_pairs; -- expect 0

BEGIN;

CREATE TABLE cambium.companions (
    id                SERIAL  PRIMARY KEY,
    seed_id           INTEGER NOT NULL REFERENCES cambium.seeds(id) ON DELETE CASCADE,
    companion_seed_id INTEGER NOT NULL REFERENCES cambium.seeds(id) ON DELETE CASCADE,
    relationship      TEXT    NOT NULL CHECK (relationship IN ('beneficial', 'antagonistic', 'neutral')),
    confidence        INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 100),
    notes             TEXT,
    source            TEXT,
    UNIQUE (seed_id, companion_seed_id),
    CHECK (seed_id <> companion_seed_id)
);

CREATE INDEX cambium_companions_seed_id_idx ON cambium.companions (seed_id);

DROP TABLE IF EXISTS cambium.plant_tags;
DROP TABLE IF EXISTS cambium.tags;
DROP TABLE IF EXISTS cambium.soil_preferences;
DROP TABLE IF EXISTS cambium.growing_attributes;
DROP TABLE IF EXISTS cambium.companion_data;
DROP TABLE IF EXISTS cambium.plants;
DROP TABLE IF EXISTS cambium.companion_pairs;

COMMIT;

-- Cambium Plants Schema — Phase 08
-- Richer plant knowledge graph: plants, growing attributes, soil preferences,
-- directional companion data, and a tagging system.
-- The existing cambium.seeds / seed_ratings / companion_pairs tables are unchanged.

BEGIN;

CREATE TABLE cambium.plants (
    id             BIGSERIAL   PRIMARY KEY,
    slug           TEXT        UNIQUE NOT NULL,
    botanical_name TEXT        NOT NULL,
    common_names   TEXT[]      NOT NULL DEFAULT '{}',
    description    TEXT,
    family         TEXT,
    genus          TEXT        NOT NULL,
    species        TEXT        NOT NULL,
    cultivar       TEXT,
    is_published   BOOLEAN     NOT NULL DEFAULT false,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE cambium.growing_attributes (
    id                      SERIAL  PRIMARY KEY,
    plant_id                BIGINT  NOT NULL UNIQUE REFERENCES cambium.plants(id) ON DELETE CASCADE,
    days_to_germination_min INTEGER,
    days_to_germination_max INTEGER,
    days_to_maturity_min    INTEGER,
    days_to_maturity_max    INTEGER,
    spacing_cm_min          NUMERIC(6,2),
    spacing_cm_max          NUMERIC(6,2),
    row_spacing_cm          NUMERIC(6,2),
    plant_height_cm_min     NUMERIC(6,2),
    plant_height_cm_max     NUMERIC(6,2),
    sun_requirements        TEXT,
    water_requirements      TEXT,
    frost_hardy             BOOLEAN,
    direct_sow              BOOLEAN,
    transplant              BOOLEAN
);

CREATE TABLE cambium.soil_preferences (
    id                  SERIAL  PRIMARY KEY,
    plant_id            BIGINT  NOT NULL UNIQUE REFERENCES cambium.plants(id) ON DELETE CASCADE,
    ph_min              NUMERIC(4,2),
    ph_max              NUMERIC(4,2),
    nitrogen_demand     TEXT,
    phosphorus_demand   TEXT,
    potassium_demand    TEXT,
    moisture_preference TEXT,
    drainage            TEXT
);

-- Directional companion relationship: plant_id benefits from / is harmed by companion_plant_id
CREATE TABLE cambium.companion_data (
    id                 SERIAL  PRIMARY KEY,
    plant_id           BIGINT  NOT NULL REFERENCES cambium.plants(id) ON DELETE CASCADE,
    companion_plant_id BIGINT  NOT NULL REFERENCES cambium.plants(id) ON DELETE CASCADE,
    relationship       TEXT    NOT NULL CHECK (relationship IN ('beneficial', 'antagonistic', 'neutral')),
    confidence         INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 100),
    notes              TEXT,
    source             TEXT,
    UNIQUE (plant_id, companion_plant_id)
);

CREATE TABLE cambium.tags (
    id       SERIAL PRIMARY KEY,
    slug     TEXT   UNIQUE NOT NULL,
    label    TEXT   NOT NULL,
    category TEXT
);

CREATE TABLE cambium.plant_tags (
    plant_id BIGINT  NOT NULL REFERENCES cambium.plants(id) ON DELETE CASCADE,
    tag_id   INTEGER NOT NULL REFERENCES cambium.tags(id) ON DELETE CASCADE,
    PRIMARY KEY (plant_id, tag_id)
);

-- Indexes
CREATE INDEX cambium_plants_botanical_name_idx ON cambium.plants (botanical_name);
CREATE INDEX cambium_plants_is_published_idx   ON cambium.plants (is_published) WHERE is_published = true;
CREATE INDEX cambium_companion_data_plant_idx  ON cambium.companion_data (plant_id);
CREATE INDEX cambium_plant_tags_plant_idx      ON cambium.plant_tags (plant_id);
CREATE INDEX cambium_plant_tags_tag_idx        ON cambium.plant_tags (tag_id);

COMMIT;

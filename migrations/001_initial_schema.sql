-- Vernal — Initial Schema
-- Consolidated from: SchemaDesign_2026-05-16, SchemaPatch_SurfaceSpecs_2026-05-19,
-- SchemaPatch_AdminMobile_2026-05-19, SchemaPatch_PaidDataCanvas_2026-05-20
-- All patches applied in final CREATE TABLE form — no ALTER TABLE deltas.

BEGIN;

-- ── Extensions ────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Cambium lives in a separate schema within the same database cluster.
-- Vernal application code only queries public.*; Cambium queries cambium.*
CREATE SCHEMA IF NOT EXISTS cambium;

-- ── Auth & Sessions ───────────────────────────────────────────────────────────

CREATE TABLE accounts (
    id                        SERIAL      PRIMARY KEY,
    email                     TEXT        UNIQUE NOT NULL,
    password_hash             TEXT,                          -- null for OAuth-only accounts
    zone                      TEXT        NOT NULL,          -- USDA zone string e.g. "6b"
    zone_location_label       TEXT        NOT NULL,          -- display label e.g. "Portland, OR"
    last_spring_frost_date    DATE,
    first_fall_frost_date     DATE,
    subscription_tier         TEXT        NOT NULL DEFAULT 'free'
                              CHECK (subscription_tier IN ('free', 'supporter')),
    -- Profile
    display_name              TEXT,
    avatar_url                TEXT,
    pending_email             TEXT,                          -- set during email change flow
    deletion_scheduled_at     TIMESTAMPTZ,                   -- set when account deletion is queued
    -- Stripe billing
    stripe_customer_id        TEXT        UNIQUE,
    stripe_subscription_id    TEXT,
    subscription_interval     TEXT
                              CHECK (subscription_interval IN ('monthly', 'annual', 'lifetime')),
    subscription_period_end   TIMESTAMPTZ,
    subscription_cancelled_at TIMESTAMPTZ,
    -- Micro-feedback shown flags (one per trigger; prevents re-showing)
    mf_viewed_seed            BOOLEAN     NOT NULL DEFAULT false,
    mf_planted                BOOLEAN     NOT NULL DEFAULT false,
    mf_harvest_logged         BOOLEAN     NOT NULL DEFAULT false,
    mf_cross_season           BOOLEAN     NOT NULL DEFAULT false,
    mf_data_export            BOOLEAN     NOT NULL DEFAULT false,
    -- Supporter upgrade prompt
    supporter_prompt_shown    BOOLEAN     NOT NULL DEFAULT false,
    -- Admin role
    role                      TEXT        NOT NULL DEFAULT 'user'
                              CHECK (role IN ('user', 'admin')),
    -- Per-user UI preferences (JSONB — see schema docs for documented keys)
    preferences               JSONB       NOT NULL DEFAULT '{}',
    -- Activity tracking for admin dashboard
    last_active_at            TIMESTAMPTZ,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE guest_sessions (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    token       TEXT        UNIQUE NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL,
    migrated_at TIMESTAMPTZ,                                 -- null = still a guest
    account_id  INTEGER     REFERENCES accounts(id) ON DELETE SET NULL
);

CREATE TABLE oauth_identities (
    id               SERIAL      PRIMARY KEY,
    account_id       INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    provider         TEXT        NOT NULL,                   -- 'google', 'github', etc.
    provider_user_id TEXT        NOT NULL,
    provider_email   TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (provider, provider_user_id)
);

CREATE TABLE password_reset_tokens (
    id          SERIAL      PRIMARY KEY,
    account_id  INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    token_hash  TEXT        UNIQUE NOT NULL,                 -- bcrypt hash of raw token
    expires_at  TIMESTAMPTZ NOT NULL,
    used_at     TIMESTAMPTZ                                  -- null = unused
);

-- ── Seeds (public schema) — must precede plantings ────────────────────────────

CREATE TABLE seeds (
    id                        SERIAL      PRIMARY KEY,
    owner_id                  INTEGER     REFERENCES accounts(id) ON DELETE CASCADE,
    guest_session_id          UUID        REFERENCES guest_sessions(id) ON DELETE CASCADE,
    common_name               TEXT        NOT NULL,
    scientific_name           TEXT,
    plant_family              TEXT,
    cambium_source_id         INTEGER,    -- FK to cambium.seeds — no constraint (cross-schema)
    origin                    TEXT        NOT NULL
                              CHECK (origin IN ('user_created', 'cambium_imported', 'cambium_linked')),
    contribution_status       TEXT        NOT NULL DEFAULT 'private'
                              CHECK (contribution_status IN ('private', 'pending', 'approved', 'rejected')),
    spacing_inches            NUMERIC(6,2),
    maturity_days_min         INTEGER,
    maturity_days_max         INTEGER,
    sunlight                  TEXT        CHECK (sunlight IN ('full_sun', 'partial_shade', 'full_shade')),
    watering_needs            TEXT        CHECK (watering_needs IN ('low', 'moderate', 'high')),
    hardiness_zone_min        TEXT,
    hardiness_zone_max        TEXT,
    frost_tolerance           TEXT        CHECK (frost_tolerance IN ('none', 'light', 'hard')),
    weeks_to_transplant       INTEGER,
    succession_interval_weeks INTEGER,
    user_notes                TEXT,
    user_rating               INTEGER     CHECK (user_rating BETWEEN 1 AND 5),
    is_favourite              BOOLEAN     NOT NULL DEFAULT false,
    illustration_key          TEXT,       -- CDN key for growth stage SVGs on R2
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (owner_id IS NOT NULL OR guest_session_id IS NOT NULL)
);

CREATE TABLE seed_photos (
    id          SERIAL      PRIMARY KEY,
    seed_id     INTEGER     NOT NULL REFERENCES seeds(id) ON DELETE CASCADE,
    storage_url TEXT        NOT NULL,   -- Cloudflare R2 URL
    taken_at    DATE,
    notes       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Gardens & Canvas ──────────────────────────────────────────────────────────

CREATE TABLE gardens (
    id                     SERIAL      PRIMARY KEY,
    owner_id               INTEGER     REFERENCES accounts(id) ON DELETE CASCADE,
    guest_session_id       UUID        REFERENCES guest_sessions(id) ON DELETE CASCADE,
    name                   TEXT        NOT NULL,
    style                  TEXT        NOT NULL CHECK (style IN ('grid', 'freeform', 'mixed')),
    zone                   TEXT        NOT NULL,
    last_accessed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    harvestable_count      INTEGER     NOT NULL DEFAULT 0,  -- denormalized; updated on planting changes
    has_companion_warnings BOOLEAN     NOT NULL DEFAULT false,
    thumbnail_url          TEXT,                            -- Konva stage.toDataURL() stored on R2
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (owner_id IS NOT NULL OR guest_session_id IS NOT NULL)
);

CREATE TABLE beds (
    id              SERIAL      PRIMARY KEY,
    garden_id       INTEGER     NOT NULL REFERENCES gardens(id) ON DELETE CASCADE,
    season          INTEGER     NOT NULL,                   -- calendar year e.g. 2026
    type            TEXT        NOT NULL CHECK (type IN ('grid', 'freeform')),
    label           TEXT        NOT NULL DEFAULT '',
    -- Grid beds: these columns populated; freeform columns null
    grid_x          INTEGER,
    grid_y          INTEGER,
    grid_cols       INTEGER,
    grid_rows       INTEGER,
    -- Freeform beds: flat array [x1,y1,x2,y2,...] in canvas coordinates
    freeform_points JSONB,
    freeform_closed BOOLEAN,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (
        (type = 'grid'     AND grid_x IS NOT NULL AND grid_y IS NOT NULL
                           AND grid_cols IS NOT NULL AND grid_rows IS NOT NULL)
        OR
        (type = 'freeform' AND freeform_points IS NOT NULL AND freeform_closed IS NOT NULL)
    )
);

CREATE TABLE plantings (
    id                     SERIAL      PRIMARY KEY,
    bed_id                 INTEGER     NOT NULL REFERENCES beds(id) ON DELETE CASCADE,
    garden_id              INTEGER     NOT NULL REFERENCES gardens(id) ON DELETE CASCADE,
    season                 INTEGER     NOT NULL,
    seed_id                INTEGER     REFERENCES seeds(id) ON DELETE SET NULL,
    cambium_seed_id        INTEGER,    -- FK to cambium.seeds — no constraint (cross-schema)
    quantity               INTEGER     NOT NULL DEFAULT 1,
    planting_date          DATE,
    -- Grid beds: cell_x/cell_y populated; freeform beds: point_x/point_y populated
    cell_x                 INTEGER,
    cell_y                 INTEGER,
    point_x                NUMERIC,
    point_y                NUMERIC,
    -- Nightly derived — do not write from application routes
    growth_stage_pct       NUMERIC(5,2),
    growth_stage           SMALLINT    CHECK (growth_stage BETWEEN 1 AND 5),
    displayed_growth_stage SMALLINT    CHECK (displayed_growth_stage BETWEEN 1 AND 5),
    harvest_ready          BOOLEAN     NOT NULL DEFAULT false,
    harvest_window_end     DATE,
    indicator_dismissed_at TIMESTAMPTZ,                     -- manual harvest-ready dismiss
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (seed_id IS NOT NULL OR cambium_seed_id IS NOT NULL)
);

-- Versioned JSON render cache; regenerated on any canvas write
CREATE TABLE canvas_render_cache (
    garden_id      INTEGER NOT NULL REFERENCES gardens(id) ON DELETE CASCADE,
    season         INTEGER NOT NULL,
    canvas_version INTEGER NOT NULL DEFAULT 1,
    data           JSONB   NOT NULL,
    generated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (garden_id, season)
);

-- Per-season snapshot for the season history overlay
CREATE TABLE canvas_snapshots (
    garden_id    INTEGER     NOT NULL REFERENCES gardens(id) ON DELETE CASCADE,
    season       INTEGER     NOT NULL,
    snapshot     JSONB       NOT NULL,
    generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (garden_id, season)
);

-- ── Cambium Schema ────────────────────────────────────────────────────────────

CREATE TABLE cambium.seeds (
    id                        SERIAL      PRIMARY KEY,
    common_name               TEXT        NOT NULL,
    scientific_name           TEXT,
    plant_family              TEXT,
    spacing_inches            NUMERIC(6,2),
    maturity_days_min         INTEGER,
    maturity_days_max         INTEGER,
    sunlight                  TEXT,
    watering_needs            TEXT,
    hardiness_zone_min        TEXT,
    hardiness_zone_max        TEXT,
    frost_tolerance           TEXT,
    weeks_to_transplant       INTEGER,
    succession_interval_weeks INTEGER,
    illustration_key          TEXT,
    aggregate_rating          NUMERIC(3,2),
    rating_count              INTEGER     NOT NULL DEFAULT 0,
    moderation_status         TEXT        NOT NULL DEFAULT 'active'
                              CHECK (moderation_status IN ('active', 'flagged', 'inactive')),
    source                    TEXT        NOT NULL
                              CHECK (source IN ('openfarm', 'community', 'editorial')),
    openfarm_id               TEXT,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE cambium.seed_ratings (
    id         SERIAL  PRIMARY KEY,
    seed_id    INTEGER NOT NULL REFERENCES cambium.seeds(id) ON DELETE CASCADE,
    account_id INTEGER NOT NULL,    -- references public.accounts — no FK constraint (cross-schema)
    rating     INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (seed_id, account_id)
);

-- relationship: beneficial = A helps B; harmful = A inhibits B
-- seed_id_a < seed_id_b enforced by CHECK to prevent duplicate reverse pairs
CREATE TABLE cambium.companion_pairs (
    id           SERIAL  PRIMARY KEY,
    seed_id_a    INTEGER NOT NULL REFERENCES cambium.seeds(id) ON DELETE CASCADE,
    seed_id_b    INTEGER NOT NULL REFERENCES cambium.seeds(id) ON DELETE CASCADE,
    relationship TEXT    NOT NULL CHECK (relationship IN ('beneficial', 'harmful')),
    notes        TEXT,
    source       TEXT,
    CHECK (seed_id_a < seed_id_b)
);

-- ── Planting Guide & Harvest ──────────────────────────────────────────────────

CREATE TABLE sowing_events (
    id              SERIAL      PRIMARY KEY,
    planting_id     INTEGER     REFERENCES plantings(id) ON DELETE SET NULL,
    garden_id       INTEGER     NOT NULL REFERENCES gardens(id) ON DELETE CASCADE,
    seed_id         INTEGER     REFERENCES seeds(id) ON DELETE SET NULL,
    cambium_seed_id INTEGER,
    season          INTEGER     NOT NULL,
    marked_done_at  TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (seed_id IS NOT NULL OR cambium_seed_id IS NOT NULL)
);

CREATE TABLE harvest_entries (
    id              SERIAL      PRIMARY KEY,
    sowing_event_id INTEGER     REFERENCES sowing_events(id) ON DELETE SET NULL,
    garden_id       INTEGER     NOT NULL REFERENCES gardens(id) ON DELETE CASCADE,
    seed_id         INTEGER     REFERENCES seeds(id) ON DELETE SET NULL,
    cambium_seed_id INTEGER,
    harvested_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    quantity        NUMERIC,
    unit            TEXT,       -- 'g','kg','oz','lb','count'; null if quantity not recorded
    quality_rating  INTEGER     CHECK (quality_rating BETWEEN 1 AND 5),
    notes           TEXT,
    photos          JSONB       NOT NULL DEFAULT '[]',    -- R2 URL/key references; never null
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE user_seed_preferences (
    id                       SERIAL  PRIMARY KEY,
    account_id               INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    seed_id                  INTEGER REFERENCES seeds(id) ON DELETE CASCADE,
    cambium_seed_id          INTEGER,
    garden_id                INTEGER NOT NULL REFERENCES gardens(id) ON DELETE CASCADE,
    custom_indoor_start_date DATE,
    custom_transplant_date   DATE,
    custom_direct_sow_date   DATE,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (seed_id IS NOT NULL OR cambium_seed_id IS NOT NULL)
);

-- ── Paid Features ─────────────────────────────────────────────────────────────

CREATE TABLE soil_readings (
    id             SERIAL      PRIMARY KEY,
    user_id        INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    garden_id      INTEGER     NOT NULL REFERENCES gardens(id) ON DELETE CASCADE,
    bed_id         INTEGER     NOT NULL REFERENCES beds(id) ON DELETE CASCADE,
    test_date      DATE        NOT NULL,
    ph             NUMERIC(4,2),
    nitrogen_ppm   INTEGER,
    phosphorus_ppm INTEGER,
    potassium_ppm  INTEGER,
    notes          TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE amendment_logs (
    id                 SERIAL      PRIMARY KEY,
    user_id            INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    garden_id          INTEGER     NOT NULL REFERENCES gardens(id) ON DELETE CASCADE,
    application_date   DATE        NOT NULL,
    product_name       TEXT        NOT NULL,
    amendment_type     TEXT        NOT NULL
                       CHECK (amendment_type IN (
                           'fertilizer_synthetic', 'fertilizer_organic',
                           'compost_manure', 'lime', 'sulphur', 'mulch', 'other'
                       )),
    amount             NUMERIC,
    amount_unit        TEXT,
    application_method TEXT,
    notes              TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Multi-bed applications: one row per bed per amendment
CREATE TABLE amendment_log_beds (
    amendment_log_id INTEGER NOT NULL REFERENCES amendment_logs(id) ON DELETE CASCADE,
    bed_id           INTEGER NOT NULL REFERENCES beds(id) ON DELETE CASCADE,
    PRIMARY KEY (amendment_log_id, bed_id)
);

CREATE TABLE weather_connections (
    id                   SERIAL      PRIMARY KEY,
    account_id           INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    provider             TEXT        NOT NULL
                         CHECK (provider IN (
                             'pws_tempest', 'pws_ambient', 'pws_davis',
                             'pws_ecowitt', 'pws_other', 'public_weather'
                         )),
    credentials          JSONB       NOT NULL DEFAULT '{}',  -- encrypted at application layer
    station_id           TEXT,
    is_primary           BOOLEAN     NOT NULL DEFAULT false,
    last_successful_sync TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Cache of readings fetched from connected weather sources
CREATE TABLE weather_readings (
    id                  SERIAL      PRIMARY KEY,
    connection_id       INTEGER     NOT NULL REFERENCES weather_connections(id) ON DELETE CASCADE,
    reading_timestamp   TIMESTAMPTZ NOT NULL,
    temperature         NUMERIC,
    humidity            NUMERIC,
    wind_speed          NUMERIC,
    wind_direction      TEXT,
    precipitation_today NUMERIC,
    uv_index            NUMERIC,
    pressure            NUMERIC,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Community & Moderation ────────────────────────────────────────────────────

-- Unified moderation queue for seed corrections and new seed submissions
CREATE TABLE moderation_items (
    id              SERIAL      PRIMARY KEY,
    type            TEXT        NOT NULL CHECK (type IN ('correction', 'new_seed')),
    seed_id         INTEGER     REFERENCES seeds(id) ON DELETE CASCADE,
    cambium_seed_id INTEGER,    -- FK to cambium.seeds — no constraint (cross-schema)
    submitted_by    INTEGER     REFERENCES accounts(id) ON DELETE SET NULL,
    content         JSONB       NOT NULL,
    status          TEXT        NOT NULL DEFAULT 'new'
                    CHECK (status IN ('new', 'under_review', 'approved', 'rejected')),
    resolution_note TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at     TIMESTAMPTZ
);

-- ── Notifications ─────────────────────────────────────────────────────────────

CREATE TABLE notifications (
    id         SERIAL      PRIMARY KEY,
    account_id INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    type       TEXT        NOT NULL
               CHECK (type IN (
                   'guest_expiry_warning', 'contribution_rejected',
                   'contribution_approved', 'correction_applied', 'cambium_source_updated'
               )),
    payload    JSONB       NOT NULL DEFAULT '{}',
    read_at    TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Analytics & Events ────────────────────────────────────────────────────────

CREATE TABLE usage_events (
    id         SERIAL      PRIMARY KEY,
    user_id    INTEGER     REFERENCES accounts(id) ON DELETE SET NULL,  -- null = guest
    session_id TEXT        NOT NULL,
    event_key  TEXT        NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE micro_feedback_responses (
    id          SERIAL      PRIMARY KEY,
    account_id  INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    trigger_key TEXT        NOT NULL,
    response    TEXT        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE feedback_submissions (
    id             SERIAL      PRIMARY KEY,
    user_id        INTEGER     REFERENCES accounts(id) ON DELETE SET NULL,
    category       TEXT        NOT NULL
                   CHECK (category IN ('bug', 'feature_request', 'general', 'data_quality')),
    message        TEXT        NOT NULL,
    source_surface TEXT,
    app_version    TEXT,
    status         TEXT        NOT NULL DEFAULT 'new'
                   CHECK (status IN ('new', 'reviewed', 'closed')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Stripe & Exports ──────────────────────────────────────────────────────────

-- Idempotency table for Stripe webhook events
CREATE TABLE stripe_events (
    event_id     TEXT        PRIMARY KEY,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE data_export_jobs (
    id           SERIAL      PRIMARY KEY,
    account_id   INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    status       TEXT        NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'processing', 'complete', 'failed')),
    requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    download_url TEXT,
    expires_at   TIMESTAMPTZ
);

-- ── Jobs & System ─────────────────────────────────────────────────────────────

-- Record of background job executions for the admin System Health panel
CREATE TABLE job_runs (
    id          SERIAL      PRIMARY KEY,
    job_key     TEXT        NOT NULL,
    status      TEXT        NOT NULL CHECK (status IN ('ok', 'failed')),
    started_at  TIMESTAMPTZ NOT NULL,
    finished_at TIMESTAMPTZ,
    error_msg   TEXT
);

-- ── Indexes ───────────────────────────────────────────────────────────────────

-- guest_sessions
CREATE INDEX guest_sessions_expires_at_idx  ON guest_sessions (expires_at);
CREATE INDEX guest_sessions_account_id_idx  ON guest_sessions (account_id) WHERE account_id IS NOT NULL;

-- accounts
CREATE INDEX accounts_role_idx              ON accounts (role) WHERE role = 'admin';
CREATE INDEX accounts_last_active_at_idx    ON accounts (last_active_at DESC) WHERE last_active_at IS NOT NULL;
CREATE INDEX accounts_subscription_tier_idx ON accounts (subscription_tier);

-- gardens
CREATE INDEX gardens_owner_id_idx           ON gardens (owner_id) WHERE owner_id IS NOT NULL;
CREATE INDEX gardens_guest_session_id_idx   ON gardens (guest_session_id) WHERE guest_session_id IS NOT NULL;
CREATE INDEX gardens_last_accessed_at_idx   ON gardens (last_accessed_at DESC);

-- beds
CREATE INDEX beds_garden_season_idx         ON beds (garden_id, season);

-- plantings
CREATE INDEX plantings_bed_id_idx           ON plantings (bed_id);
CREATE INDEX plantings_garden_season_idx    ON plantings (garden_id, season);
CREATE INDEX plantings_seed_id_idx          ON plantings (seed_id) WHERE seed_id IS NOT NULL;
CREATE INDEX plantings_cambium_seed_id_idx  ON plantings (cambium_seed_id) WHERE cambium_seed_id IS NOT NULL;
CREATE INDEX plantings_harvest_ready_idx    ON plantings (garden_id) WHERE harvest_ready = true;

-- seeds
CREATE INDEX seeds_owner_id_idx             ON seeds (owner_id) WHERE owner_id IS NOT NULL;
CREATE INDEX seeds_guest_session_id_idx     ON seeds (guest_session_id) WHERE guest_session_id IS NOT NULL;
CREATE INDEX seeds_cambium_source_id_idx    ON seeds (cambium_source_id) WHERE cambium_source_id IS NOT NULL;
CREATE INDEX seeds_plant_family_idx         ON seeds (plant_family);
CREATE INDEX seeds_name_fts_idx             ON seeds USING gin(
    to_tsvector('english', common_name || ' ' || COALESCE(scientific_name, ''))
);

-- cambium.seeds
CREATE INDEX cambium_seeds_plant_family_idx       ON cambium.seeds (plant_family);
CREATE INDEX cambium_seeds_moderation_status_idx  ON cambium.seeds (moderation_status);
CREATE INDEX cambium_seeds_name_fts_idx           ON cambium.seeds USING gin(
    to_tsvector('english', common_name || ' ' || COALESCE(scientific_name, ''))
);

-- sowing_events
CREATE INDEX sowing_events_planting_id_idx    ON sowing_events (planting_id) WHERE planting_id IS NOT NULL;
CREATE INDEX sowing_events_garden_season_idx  ON sowing_events (garden_id, season);

-- harvest_entries
CREATE INDEX harvest_entries_sowing_event_id_idx ON harvest_entries (sowing_event_id) WHERE sowing_event_id IS NOT NULL;
CREATE INDEX harvest_entries_garden_id_idx       ON harvest_entries (garden_id);
CREATE INDEX harvest_entries_harvested_at_idx    ON harvest_entries (harvested_at DESC);

-- user_seed_preferences (partial unique indexes)
CREATE UNIQUE INDEX user_seed_prefs_personal_uq
    ON user_seed_preferences (account_id, seed_id, garden_id)
    WHERE seed_id IS NOT NULL;
CREATE UNIQUE INDEX user_seed_prefs_cambium_uq
    ON user_seed_preferences (account_id, cambium_seed_id, garden_id)
    WHERE cambium_seed_id IS NOT NULL;

-- soil_readings
CREATE INDEX soil_readings_garden_id_idx ON soil_readings (garden_id);
CREATE INDEX soil_readings_bed_id_idx    ON soil_readings (bed_id);

-- amendment_logs
CREATE INDEX amendment_logs_garden_id_idx   ON amendment_logs (garden_id);
CREATE INDEX amendment_logs_user_date_idx   ON amendment_logs (user_id, application_date DESC);
CREATE INDEX amendment_logs_type_idx        ON amendment_logs (amendment_type);
CREATE INDEX amendment_log_beds_bed_id_idx  ON amendment_log_beds (bed_id);

-- weather_connections
CREATE UNIQUE INDEX weather_connections_primary_per_account_idx
    ON weather_connections (account_id) WHERE is_primary = true;
CREATE INDEX weather_connections_account_id_idx ON weather_connections (account_id);

-- weather_readings
CREATE INDEX weather_readings_connection_recent_idx
    ON weather_readings (connection_id, reading_timestamp DESC);

-- moderation_items
CREATE INDEX moderation_items_status_type_idx      ON moderation_items (status, type);
CREATE INDEX moderation_items_submitted_by_idx     ON moderation_items (submitted_by) WHERE submitted_by IS NOT NULL;
CREATE INDEX moderation_items_cambium_seed_id_idx  ON moderation_items (cambium_seed_id) WHERE cambium_seed_id IS NOT NULL;

-- notifications
CREATE INDEX notifications_account_unread_idx
    ON notifications (account_id, created_at DESC) WHERE read_at IS NULL;

-- usage_events
CREATE INDEX usage_events_event_key_30d_idx
    ON usage_events (event_key, created_at DESC);
CREATE INDEX usage_events_user_id_idx
    ON usage_events (user_id) WHERE user_id IS NOT NULL;

-- job_runs
CREATE INDEX job_runs_job_key_idx ON job_runs (job_key, started_at DESC);

COMMIT;

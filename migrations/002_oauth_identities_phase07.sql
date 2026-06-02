-- Phase 07: add encrypted token storage and profile columns to oauth_identities.
-- The initial schema (001) created the table with only identity-linking fields.
-- These columns support token encryption (AES-256-GCM BYTEA storage) and
-- profile data captured at OAuth time.

ALTER TABLE oauth_identities
    ADD COLUMN IF NOT EXISTS email                     TEXT,
    ADD COLUMN IF NOT EXISTS display_name              TEXT,
    ADD COLUMN IF NOT EXISTS avatar_url                TEXT,
    ADD COLUMN IF NOT EXISTS access_token_encrypted    BYTEA,
    ADD COLUMN IF NOT EXISTS refresh_token_encrypted   BYTEA,
    ADD COLUMN IF NOT EXISTS token_expires_at          TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS updated_at                TIMESTAMPTZ;

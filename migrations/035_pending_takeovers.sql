-- 035_pending_takeovers.sql
-- A Google sign-in that proves the inbox of an UNVERIFIED account no longer
-- displaces it straight away: the person is asked whether they created the
-- account. This holds the sign-in for 15 minutes while they answer. Only the
-- SHA-256 of the token sent to the browser is stored.
-- Additive only: the previous release never reads or writes it.
BEGIN;

CREATE TABLE pending_takeovers (
    id                      SERIAL      PRIMARY KEY,
    token_hash              TEXT        UNIQUE NOT NULL,
    account_id              INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    provider                TEXT        NOT NULL,
    provider_user_id        TEXT        NOT NULL,
    email                   TEXT        NOT NULL,
    display_name            TEXT        NOT NULL,
    avatar_url              TEXT,
    access_token_encrypted  BYTEA       NOT NULL,
    refresh_token_encrypted BYTEA,
    -- Set only when the sign-in started from a guest (not a signed-in account).
    guest_session_id        UUID        REFERENCES guest_sessions(id) ON DELETE SET NULL,
    return_to               TEXT        NOT NULL DEFAULT '/',
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at              TIMESTAMPTZ NOT NULL
);

CREATE INDEX pending_takeovers_account_id_idx ON pending_takeovers (account_id);
CREATE INDEX pending_takeovers_expires_at_idx ON pending_takeovers (expires_at);

COMMIT;

-- Phase 36: email change confirmation tokens.
-- Mirrors password_reset_tokens: raw token is emailed to the user, only its
-- SHA-256 hash is stored. new_email carries the pending address so the
-- confirm endpoint doesn't have to trust accounts.pending_email at click time.

BEGIN;

CREATE TABLE email_change_tokens (
    id         SERIAL      PRIMARY KEY,
    account_id INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    token_hash TEXT        UNIQUE NOT NULL,   -- SHA-256 hash of raw token
    new_email  TEXT        NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at    TIMESTAMPTZ,                   -- null = unused
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX email_change_tokens_account_id_idx ON email_change_tokens (account_id);

COMMIT;

-- 018_email_verification_tokens.sql
-- Soft email verification (audit #1). Raw token is emailed; only its SHA-256
-- hash is stored. `email` pins the address being verified so a stale link
-- can't verify an address the account has since changed.
BEGIN;

-- Fail fast instead of queueing behind a long transaction and blocking writes.
SET LOCAL lock_timeout = '5s';

CREATE TABLE email_verification_tokens (
    id         SERIAL      PRIMARY KEY,
    account_id INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    email      TEXT        NOT NULL,
    token_hash TEXT        UNIQUE NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at    TIMESTAMPTZ
);

CREATE INDEX email_verification_tokens_account_idx ON email_verification_tokens (account_id);

COMMIT;

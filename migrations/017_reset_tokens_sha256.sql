-- 017_reset_tokens_sha256.sql
-- Reset tokens move from bcrypt to SHA-256 so lookup uses the UNIQUE index
-- instead of bcrypt-comparing every outstanding row (audit #3). Existing rows
-- are bcrypt hashes that can't be converted; they live at most one hour.
BEGIN;

-- Fail fast instead of queueing behind a long transaction and blocking writes.
SET LOCAL lock_timeout = '5s';

DELETE FROM password_reset_tokens;

COMMENT ON COLUMN password_reset_tokens.token_hash IS 'SHA-256 hex of the raw token';

COMMIT;

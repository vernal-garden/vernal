-- 025_session_token_column_drop.sql
-- Step 2 of retiring guest_sessions.token (see 021, 024). 024 cleared every
-- raw token and the release deployed with it no longer names the column, so
-- it can go. Sessions are keyed by token_hash only.
BEGIN;

ALTER TABLE guest_sessions DROP COLUMN token;

COMMIT;

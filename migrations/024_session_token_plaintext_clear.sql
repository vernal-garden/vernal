-- 024_session_token_plaintext_clear.sql
-- Step 1 of retiring guest_sessions.token (see 021). Clears every raw token
-- still stored (rows created before 021 kept theirs until they rotated) and
-- drops the trigger that hashed old-code writes. token_hash was backfilled by
-- 021, so no session is logged out.
--
-- The column stays for now: the deploy migrates minutes before pm2 reloads,
-- and the previous release still runs `SET token = NULL` on login. That needs
-- the column but not the trigger. A later migration drops the column once no
-- running code names it.
BEGIN;

UPDATE guest_sessions SET token = NULL WHERE token IS NOT NULL;
DROP TRIGGER guest_sessions_fill_token_hash ON guest_sessions;
DROP FUNCTION guest_sessions_fill_token_hash();

COMMIT;

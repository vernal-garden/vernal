-- 036_pending_takeover_browser.sql
-- Binds a held Google sign-in to the browser that started it: the callback
-- also sets a cookie holding a second random value, and only its SHA-256 is
-- stored here. Completing the takeover needs both the token and the cookie.
-- Additive only: the previous release never reads or writes it. Rows without
-- it (held by the previous release) can't be completed; they expire within
-- 15 minutes and the person signs in with Google again.
BEGIN;

ALTER TABLE pending_takeovers ADD COLUMN browser_hash TEXT;

COMMIT;

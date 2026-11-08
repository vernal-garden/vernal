-- 033_account_claimed_at.sql
-- When an account was last taken back by someone proving the inbox (Google
-- sign-in claim, or a password reset on an unverified account). Terms accepted
-- before then may not be the owner's, so the owner must accept them again.
-- Additive only: the previous release never reads or writes it.
BEGIN;

ALTER TABLE accounts ADD COLUMN claimed_at TIMESTAMPTZ;

COMMIT;

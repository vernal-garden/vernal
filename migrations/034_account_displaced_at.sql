-- 034_account_displaced_at.sql
-- When an unverified account was deleted because the owner of its address
-- proved the inbox (Google sign-in or password reset). The owner gets a new,
-- empty account; this one is purged 30 days later like any deletion.
-- Additive only: the previous release never reads or writes it.
BEGIN;

ALTER TABLE accounts ADD COLUMN displaced_at TIMESTAMPTZ;

COMMENT ON COLUMN accounts.displaced_at IS
  'Deleted because the address''s owner proved the inbox; the account is purged 30 days later like any deletion.';

COMMIT;

-- 030_terms_acceptance.sql
-- Records which version of the Terms an account agreed to at sign-up, and when.
-- Accounts created before this migration stay NULL.
BEGIN;

ALTER TABLE accounts
  ADD COLUMN terms_version TEXT,
  ADD COLUMN terms_accepted_at TIMESTAMPTZ;

COMMIT;

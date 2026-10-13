-- 015_micro_feedback_triggers.sql
-- Feedback Pipeline spec 3.2 triggers that 001 has no flag for
-- (Robert, 2026-10-09). mf_viewed_seed and mf_data_export stay, unused.
BEGIN;
ALTER TABLE accounts
  ADD COLUMN mf_first_sowing BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN mf_upgrade      BOOLEAN NOT NULL DEFAULT false;
COMMIT;

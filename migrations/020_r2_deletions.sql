-- 020_r2_deletions.sql
-- R2 objects (single keys or folder prefixes) waiting to be deleted. Rows are
-- written in the same transaction as the DB delete they belong to and removed
-- once R2 confirms the delete. No foreign keys: rows outlive what they describe.
BEGIN;

CREATE TABLE r2_deletions (
  id          BIGSERIAL PRIMARY KEY,
  bucket      TEXT NOT NULL CHECK (bucket IN ('public', 'exports')),
  path        TEXT NOT NULL,
  is_prefix   BOOLEAN NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (NOT is_prefix OR path LIKE '%/')
);

CREATE INDEX r2_deletions_created_at_idx ON r2_deletions (created_at);

COMMIT;

-- 027_account_owner.sql
-- Audit #18. One owner account, set only by SQL (never through the API). The
-- owner can demote any admin regardless of the two-admin floor, and nobody can
-- change the owner's role in the app. No row is marked here: account ids differ
-- between environments, so prod sets it by hand after deploy.
BEGIN;

ALTER TABLE accounts ADD COLUMN is_owner BOOLEAN NOT NULL DEFAULT false;
-- The owner is always an admin, even if role is changed outside the app.
ALTER TABLE accounts ADD CONSTRAINT accounts_owner_is_admin CHECK (NOT is_owner OR role = 'admin');
-- At most one owner.
CREATE UNIQUE INDEX accounts_single_owner_idx ON accounts ((true)) WHERE is_owner;

COMMIT;

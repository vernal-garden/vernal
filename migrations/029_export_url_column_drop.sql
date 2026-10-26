-- 029_export_url_column_drop.sql
-- Step 2 of retiring data_export_jobs.download_url (see 028). 028 cleared every
-- stored link and the release deployed with it no longer names the column, so
-- it can go. Downloads are signed per request by GET /api/me/export/download.
BEGIN;

ALTER TABLE data_export_jobs DROP COLUMN download_url;

COMMIT;

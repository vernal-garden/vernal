-- 028_export_url_clear.sql
-- Export downloads now go through GET /api/me/export/download, which signs a
-- 5-minute link per request. The 7-day presigned links stored here are bearer
-- URLs; clear them.
--
-- The column stays for now: the deploy migrates minutes before pm2 reloads,
-- and the previous release still writes download_url when a job completes.
-- A later migration drops the column once no running code names it.
BEGIN;

UPDATE data_export_jobs SET download_url = NULL WHERE download_url IS NOT NULL;

COMMIT;

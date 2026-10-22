-- 023_usage_events_created_at_brin.sql
-- The nightly retention job deletes usage_events by created_at. Rows arrive in
-- created_at order, so a BRIN index keeps that range scan cheap at almost no
-- storage or write cost.
BEGIN;

CREATE INDEX usage_events_created_at_brin ON usage_events USING brin (created_at);

COMMIT;

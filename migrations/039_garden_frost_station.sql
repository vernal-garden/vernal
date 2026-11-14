-- Phase 65: the NOAA station nearest each garden's location, for its frost
-- date. Only the station ID is stored, with the location label it was worked
-- out from; never coordinates. A label with a NULL station means the lookup
-- found nothing within 100 km.
BEGIN;

ALTER TABLE gardens
  ADD COLUMN frost_station_id    TEXT,
  ADD COLUMN frost_station_label TEXT;

COMMIT;

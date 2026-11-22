-- 046_planned_plantings.sql
-- Phase 76 (planned plantings): a bed in next season can hold planned
-- plantings that have no date yet, and the nightly job sends sowing reminders.
--
-- Safe with the previous release's code: the new column has a default, so its
-- inserts still work, and the notification type is only widened.

BEGIN;

-- 1. Planned plantings. A planned planting has no planting date.
ALTER TABLE plantings
  ADD COLUMN state TEXT NOT NULL DEFAULT 'growing'
    CHECK (state IN ('planned', 'growing'));

ALTER TABLE plantings
  ADD CONSTRAINT plantings_planned_has_no_date
    CHECK (state <> 'planned' OR planting_date IS NULL);

-- 2. Allow the sowing_reminder notification type.
ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;
ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_check
    CHECK (type IN (
      'guest_expiry_warning',
      'contribution_rejected',
      'contribution_approved',
      'correction_applied',
      'cambium_source_updated',
      'sowing_reminder'
    ));

-- 3. One row per reminder sent, so a reminder is never sent twice. No PII.
CREATE TABLE sowing_reminders_sent (
  garden_id   INTEGER     NOT NULL REFERENCES gardens(id) ON DELETE CASCADE,
  seed_key    TEXT        NOT NULL,  -- seedKeyString() from sowingSync.ts
  season      INTEGER     NOT NULL,
  window_kind TEXT        NOT NULL CHECK (window_kind IN
                ('indoor_start', 'transplant', 'direct_sow')),
  reminder    TEXT        NOT NULL CHECK (reminder IN ('open', 'closing')),
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (garden_id, seed_key, season, window_kind, reminder)
);

COMMIT;

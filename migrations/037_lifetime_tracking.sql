-- 037_lifetime_tracking.sql
-- Phase 60. Beta participants' active weeks, survey credits, how they joined,
-- and their US state. Additive only: the previous release runs against it unchanged.
BEGIN;

CREATE TABLE beta_active_weeks (
    account_id      INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    week_start      DATE        NOT NULL,   -- the Monday, America/Los_Angeles
    first_active_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, week_start)
);

CREATE TABLE beta_survey_credits (
    account_id  INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    survey      SMALLINT    NOT NULL CHECK (survey IN (1, 2)),
    credited_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    credited_by INTEGER,    -- no FK, as admin_audit_log.admin_id
    PRIMARY KEY (account_id, survey)
);

ALTER TABLE accounts
  ADD COLUMN beta_joined_via              TEXT CHECK (beta_joined_via IN ('invite', 'guest')),
  ADD COLUMN residence_state              TEXT CHECK (residence_state ~ '^[A-Z]{2}$'
                                                      OR residence_state = 'OUTSIDE_US'),
  ADD COLUMN residence_state_confirmed_at TIMESTAMPTZ;

ALTER TABLE admin_audit_log DROP CONSTRAINT admin_audit_log_action_check;
ALTER TABLE admin_audit_log ADD CONSTRAINT admin_audit_log_action_check
  CHECK (action IN ('account.role', 'account.tier', 'moderation.resolve', 'feedback.status',
                    'beta.setting', 'beta.invite.add', 'beta.invite.remove',
                    'beta.invite.cleanup',
                    'beta.survey_credit.add', 'beta.survey_credit.remove'));

COMMIT;

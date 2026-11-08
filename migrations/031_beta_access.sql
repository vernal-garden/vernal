-- 031_beta_access.sql
-- Phase 59. Beta gate, guest mode and Supporter-access switches; the invite
-- list; the permanent beta-participant date; the beta terms acceptance record.
-- Additive only: the previous release runs against it unchanged.
BEGIN;

CREATE TABLE beta_settings (
    id                  SMALLINT    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    gate_on             BOOLEAN     NOT NULL DEFAULT false,
    guest_mode_on       BOOLEAN     NOT NULL DEFAULT true,
    supporter_access_on BOOLEAN     NOT NULL DEFAULT true,
    gate_first_on_at    TIMESTAMPTZ,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO beta_settings (id) VALUES (1);

CREATE TABLE beta_invites (
    id       SERIAL      PRIMARY KEY,
    email    TEXT        NOT NULL UNIQUE CHECK (email = lower(btrim(email))),
    added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    added_by INTEGER     -- no FK, as admin_audit_log.admin_id: outlives a deleted admin
);

ALTER TABLE accounts
  ADD COLUMN beta_participant_at    TIMESTAMPTZ,
  ADD COLUMN beta_terms_version     TEXT,
  ADD COLUMN beta_terms_accepted_at TIMESTAMPTZ;

-- A participant date, once set, is never cleared or changed.
CREATE FUNCTION accounts_keep_beta_participant_at() RETURNS trigger AS $$
BEGIN
  IF OLD.beta_participant_at IS NOT NULL
     AND NEW.beta_participant_at IS DISTINCT FROM OLD.beta_participant_at THEN
    RAISE EXCEPTION 'beta_participant_at is permanent (account %)', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER accounts_keep_beta_participant_at
  BEFORE UPDATE OF beta_participant_at ON accounts
  FOR EACH ROW EXECUTE FUNCTION accounts_keep_beta_participant_at();

ALTER TABLE admin_audit_log DROP CONSTRAINT admin_audit_log_action_check;
ALTER TABLE admin_audit_log ADD CONSTRAINT admin_audit_log_action_check
  CHECK (action IN ('account.role', 'account.tier', 'moderation.resolve', 'feedback.status',
                    'beta.setting', 'beta.invite.add', 'beta.invite.remove'));
ALTER TABLE admin_audit_log DROP CONSTRAINT admin_audit_log_target_type_check;
ALTER TABLE admin_audit_log ADD CONSTRAINT admin_audit_log_target_type_check
  CHECK (target_type IN ('account', 'moderation_item', 'feedback', 'beta_settings', 'beta_invite'));

COMMIT;

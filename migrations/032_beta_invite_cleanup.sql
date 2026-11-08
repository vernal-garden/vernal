-- 032_beta_invite_cleanup.sql
-- Admin "beta ended" cleanup of unused invites gets its own audit action.
-- Additive only: the previous release never writes the new value.
BEGIN;

ALTER TABLE admin_audit_log DROP CONSTRAINT admin_audit_log_action_check;
ALTER TABLE admin_audit_log ADD CONSTRAINT admin_audit_log_action_check
  CHECK (action IN ('account.role', 'account.tier', 'moderation.resolve', 'feedback.status',
                    'beta.setting', 'beta.invite.add', 'beta.invite.remove',
                    'beta.invite.cleanup'));

COMMIT;

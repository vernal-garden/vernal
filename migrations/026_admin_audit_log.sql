-- 026_admin_audit_log.sql
-- Audit #18. admin_audit_log keeps a durable record of every admin write
-- (role, tier, moderation, feedback). admin_id has no foreign key so entries
-- outlive a deleted admin account. guest_sessions.authenticated_at records when
-- a session was last linked to an account by a sign-in (login, register, OAuth,
-- password change); role changes by password-less admins require it to be recent.
BEGIN;

CREATE TABLE admin_audit_log (
    id          BIGSERIAL   PRIMARY KEY,
    admin_id    INTEGER     NOT NULL,
    action      TEXT        NOT NULL
                CHECK (action IN ('account.role', 'account.tier', 'moderation.resolve', 'feedback.status')),
    target_type TEXT        NOT NULL CHECK (target_type IN ('account', 'moderation_item', 'feedback')),
    target_id   BIGINT      NOT NULL,
    before      JSONB,
    after       JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX admin_audit_log_created_at_idx ON admin_audit_log (created_at);
CREATE INDEX admin_audit_log_target_idx ON admin_audit_log (target_type, target_id);

ALTER TABLE guest_sessions ADD COLUMN authenticated_at TIMESTAMPTZ;

COMMIT;

-- 038_owner_events.sql
-- Phase 64. Counts-only log of owner-facing events, and the digest marker.
-- No personal data: kind and time only. Additive only: the previous release runs against it unchanged.
BEGIN;

CREATE TABLE owner_events (
    id          BIGSERIAL   PRIMARY KEY,
    kind        TEXT        NOT NULL CHECK (kind IN (
                  'account_created', 'not_me', 'takeover',
                  'deletion_scheduled', 'deletion_cancelled',
                  'subscription_started', 'lifetime_purchased',
                  'subscription_cancelled', 'refund', 'dispute',
                  'beta_terms_accepted')),
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX owner_events_occurred_at_idx ON owner_events (occurred_at);

CREATE TABLE owner_digest_state (
    id           SMALLINT    PRIMARY KEY CHECK (id = 1),
    last_sent_at TIMESTAMPTZ
);
INSERT INTO owner_digest_state (id, last_sent_at) VALUES (1, NULL);

COMMIT;

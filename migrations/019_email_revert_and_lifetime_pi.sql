-- 019_email_revert_and_lifetime_pi.sql
-- Email-change revert links (mailed to the replaced address; only the SHA-256
-- hash is stored) and the payment intent behind a lifetime purchase, so a
-- refund or dispute can find the account.
BEGIN;

-- Fail fast instead of queueing behind a long transaction and blocking writes.
SET LOCAL lock_timeout = '5s';

CREATE TABLE email_revert_tokens (
    id         SERIAL      PRIMARY KEY,
    account_id INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    token_hash TEXT        UNIQUE NOT NULL,
    old_email  TEXT        NOT NULL,
    new_email  TEXT        NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at    TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX email_revert_tokens_account_idx ON email_revert_tokens (account_id);

ALTER TABLE accounts ADD COLUMN stripe_lifetime_payment_intent TEXT;

CREATE INDEX accounts_stripe_lifetime_pi_idx ON accounts (stripe_lifetime_payment_intent)
    WHERE stripe_lifetime_payment_intent IS NOT NULL;

COMMIT;

-- Phase 07: add email_verified to accounts.
-- OAuth-registered accounts are created with email_verified = true (Google has
-- already verified the address). Password-based accounts default to false;
-- a verification email flow can update this in a later phase.

ALTER TABLE accounts
    ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false;

-- 044_checkout_country_checks.sql
-- Audit log of country checks made for paid checkout (US-only at launch).
-- Stores only a Pacific date and a country code; no account or card data.
BEGIN;

CREATE TABLE checkout_country_checks (
  id BIGSERIAL PRIMARY KEY,
  occurred_on DATE NOT NULL,          -- Pacific date
  country CHAR(2),                    -- ISO 3166-1 alpha-2, NULL if unknown
  plan TEXT NOT NULL CHECK (plan IN ('monthly','annual','lifetime')),
  check_kind TEXT NOT NULL CHECK (check_kind IN
    ('before_checkout','billing_address','card_country',
     'address_change','renewal')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());

COMMIT;

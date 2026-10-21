-- 021_session_token_hash.sql
-- Session tokens are stored as sha256(token) hex in token_hash. The raw token
-- column stays (nullable) for one release: the deploy migrates before it
-- reloads, so the old process briefly writes raw tokens, and the trigger
-- hashes them. A later migration nulls and drops token and the trigger.
BEGIN;

ALTER TABLE guest_sessions ADD COLUMN token_hash TEXT;
UPDATE guest_sessions SET token_hash = encode(sha256(convert_to(token, 'UTF8')), 'hex');
ALTER TABLE guest_sessions ALTER COLUMN token_hash SET NOT NULL;
ALTER TABLE guest_sessions ADD CONSTRAINT guest_sessions_token_hash_key UNIQUE (token_hash);
ALTER TABLE guest_sessions ALTER COLUMN token DROP NOT NULL;

CREATE FUNCTION guest_sessions_fill_token_hash() RETURNS trigger AS $$
BEGIN
  IF NEW.token IS NOT NULL THEN
    NEW.token_hash := encode(sha256(convert_to(NEW.token, 'UTF8')), 'hex');
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER guest_sessions_fill_token_hash
  BEFORE INSERT OR UPDATE OF token ON guest_sessions
  FOR EACH ROW EXECUTE FUNCTION guest_sessions_fill_token_hash();

COMMIT;

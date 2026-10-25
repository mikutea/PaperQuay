-- The owner backfills every retained JSON copy while these locks prevent any
-- writer observing the temporary owner bypass of FORCE RLS. No history is cut.
LOCK TABLE paperquay.accounts, paperquay.entities, paperquay.changes,
  paperquay.operation_receipts, paperquay.conflicts IN ACCESS EXCLUSIVE MODE;
ALTER TABLE paperquay.accounts ADD COLUMN retained_bytes bigint NOT NULL DEFAULT 0
  CHECK (retained_bytes >= 0);

ALTER TABLE paperquay.accounts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE paperquay.entities NO FORCE ROW LEVEL SECURITY;
ALTER TABLE paperquay.changes NO FORCE ROW LEVEL SECURITY;
ALTER TABLE paperquay.operation_receipts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE paperquay.conflicts NO FORCE ROW LEVEL SECURITY;

-- UTF-8 JSONB text bytes plus a fixed 512-byte reserve for each retained row.
-- This bounds retained application payload, not PostgreSQL disk/WAL usage.
WITH retained AS (
  SELECT account_id, 512::bigint + octet_length(convert_to(data::text, 'UTF8')) AS bytes
    FROM paperquay.entities
  UNION ALL
  SELECT account_id, 512::bigint + octet_length(convert_to(record::text, 'UTF8'))
    FROM paperquay.changes
  UNION ALL
  SELECT account_id, 512::bigint + octet_length(convert_to(result::text, 'UTF8'))
    FROM paperquay.operation_receipts
  UNION ALL
  SELECT account_id, 512::bigint + octet_length(convert_to(attempted_operation::text, 'UTF8'))
    + octet_length(convert_to(observed_record::text, 'UTF8'))
    FROM paperquay.conflicts
), totals AS (
  SELECT account_id, sum(bytes)::bigint AS bytes FROM retained GROUP BY account_id
)
UPDATE paperquay.accounts AS account SET retained_bytes = totals.bytes
  FROM totals WHERE account.id = totals.account_id;

ALTER TABLE paperquay.accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE paperquay.entities FORCE ROW LEVEL SECURITY;
ALTER TABLE paperquay.changes FORCE ROW LEVEL SECURITY;
ALTER TABLE paperquay.operation_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE paperquay.conflicts FORCE ROW LEVEL SECURITY;

CREATE FUNCTION paperquay.enforce_retained_bytes_quota() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, paperquay AS $function$
DECLARE
  used_bytes bigint;
  new_bytes bigint := 512;
  old_bytes bigint := 0;
  byte_delta bigint;
  byte_limit bigint;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.account_id <> OLD.account_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'RETAINED_ACCOUNT_IMMUTABLE';
  END IF;
  -- The API already holds this lock; taking it here also serializes every
  -- retained-row trigger and keeps the function subject to the caller's RLS.
  SELECT retained_bytes INTO used_bytes FROM paperquay.accounts
    WHERE id = NEW.account_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'RETAINED_ACCOUNT_REQUIRED';
  END IF;

  IF TG_TABLE_NAME = 'entities' THEN
    -- INSERT ... ON CONFLICT DO UPDATE invokes both BEFORE triggers. Existing
    -- entities are charged once by the UPDATE path, never by its speculative INSERT.
    IF TG_OP = 'INSERT' AND EXISTS (
      SELECT 1 FROM paperquay.entities WHERE account_id = NEW.account_id
        AND entity_type = NEW.entity_type AND entity_id = NEW.entity_id
    ) THEN
      RETURN NEW;
    END IF;
    new_bytes := new_bytes + octet_length(convert_to(NEW.data::text, 'UTF8'));
    IF TG_OP = 'UPDATE' THEN old_bytes := 512 + octet_length(convert_to(OLD.data::text, 'UTF8')); END IF;
  ELSIF TG_TABLE_NAME = 'changes' THEN
    new_bytes := new_bytes + octet_length(convert_to(NEW.record::text, 'UTF8'));
    IF TG_OP = 'UPDATE' THEN old_bytes := 512 + octet_length(convert_to(OLD.record::text, 'UTF8')); END IF;
  ELSIF TG_TABLE_NAME = 'operation_receipts' THEN
    new_bytes := new_bytes + octet_length(convert_to(NEW.result::text, 'UTF8'));
    IF TG_OP = 'UPDATE' THEN old_bytes := 512 + octet_length(convert_to(OLD.result::text, 'UTF8')); END IF;
  ELSIF TG_TABLE_NAME = 'conflicts' THEN
    new_bytes := new_bytes + octet_length(convert_to(NEW.attempted_operation::text, 'UTF8'))
      + octet_length(convert_to(NEW.observed_record::text, 'UTF8'));
    IF TG_OP = 'UPDATE' THEN
      old_bytes := 512 + octet_length(convert_to(OLD.attempted_operation::text, 'UTF8'))
        + octet_length(convert_to(OLD.observed_record::text, 'UTF8'));
    END IF;
  ELSE
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'RETAINED_TABLE_UNSUPPORTED';
  END IF;

  byte_delta := new_bytes - old_bytes;
  -- Only trusted server configuration supplies this transaction-local setting.
  -- The default also protects an older process during the migration window.
  byte_limit := coalesce(nullif(current_setting('paperquay.retained_byte_limit', true), '')::bigint, 268435456);
  IF byte_limit < 1 OR byte_limit > 10737418240 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'RETAINED_LIMIT_INVALID';
  END IF;
  IF byte_delta > 0 AND used_bytes > byte_limit - byte_delta THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'ACCOUNT_STORAGE_LIMIT',
      CONSTRAINT = 'paperquay_account_retained_bytes_limit';
  END IF;
  IF byte_delta <> 0 THEN
    UPDATE paperquay.accounts SET retained_bytes = retained_bytes + byte_delta
      WHERE id = NEW.account_id;
  END IF;
  RETURN NEW;
END
$function$;
REVOKE ALL ON FUNCTION paperquay.enforce_retained_bytes_quota() FROM PUBLIC;

CREATE TRIGGER retained_bytes_quota BEFORE INSERT OR UPDATE ON paperquay.entities
  FOR EACH ROW EXECUTE FUNCTION paperquay.enforce_retained_bytes_quota();
CREATE TRIGGER retained_bytes_quota BEFORE INSERT OR UPDATE ON paperquay.changes
  FOR EACH ROW EXECUTE FUNCTION paperquay.enforce_retained_bytes_quota();
CREATE TRIGGER retained_bytes_quota BEFORE INSERT OR UPDATE ON paperquay.operation_receipts
  FOR EACH ROW EXECUTE FUNCTION paperquay.enforce_retained_bytes_quota();
CREATE TRIGGER retained_bytes_quota BEFORE INSERT OR UPDATE ON paperquay.conflicts
  FOR EACH ROW EXECUTE FUNCTION paperquay.enforce_retained_bytes_quota();

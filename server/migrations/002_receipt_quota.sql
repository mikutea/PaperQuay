ALTER TABLE paperquay.accounts ADD COLUMN receipt_count integer NOT NULL DEFAULT 0 CHECK (receipt_count >= 0);

-- The migrator owns these tables but normally remains subject to FORCE RLS.
-- Backfill the new counter for existing accounts inside this migration's one
-- transaction. ALTER TABLE locks prevent concurrent statements observing the
-- temporary owner bypass. Any failure rolls the entire migration back.
ALTER TABLE paperquay.accounts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE paperquay.operation_receipts NO FORCE ROW LEVEL SECURITY;
UPDATE paperquay.accounts AS account SET receipt_count = (
  SELECT count(*) FROM paperquay.operation_receipts AS receipt WHERE receipt.account_id = account.id
);
ALTER TABLE paperquay.accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE paperquay.operation_receipts FORCE ROW LEVEL SECURITY;

CREATE FUNCTION paperquay.enforce_receipt_quota() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, paperquay AS $function$
BEGIN
  UPDATE paperquay.accounts SET receipt_count = receipt_count + 1
    WHERE id = NEW.account_id AND receipt_count < 2000000;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'ACCOUNT_RECEIPT_LIMIT';
  END IF;
  RETURN NEW;
END
$function$;
REVOKE ALL ON FUNCTION paperquay.enforce_receipt_quota() FROM PUBLIC;
CREATE TRIGGER receipt_quota BEFORE INSERT ON paperquay.operation_receipts
  FOR EACH ROW EXECUTE FUNCTION paperquay.enforce_receipt_quota();

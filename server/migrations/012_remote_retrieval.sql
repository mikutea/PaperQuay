-- Lexical retrieval is a bounded server read of existing account index artifacts.
-- Source tasks, provider queues and their v1 protocol are unchanged. Queries are
-- private content; deletion keeps only immutable request/result identities.
CREATE TABLE paperquay.remote_retrieval_requests (
  account_id uuid NOT NULL REFERENCES paperquay.accounts(id),
  request_id uuid NOT NULL,
  requester_device_id uuid NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state IN ('complete','removed')),
  request_payload jsonb,
  result_payload jsonb,
  result_digest text NOT NULL CHECK (result_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id,request_id),
  FOREIGN KEY (account_id,requester_device_id) REFERENCES paperquay.devices(account_id,id),
  CHECK ((state='complete' AND request_payload IS NOT NULL AND result_payload IS NOT NULL)
    OR (state='removed' AND request_payload IS NULL AND result_payload IS NULL)),
  CHECK (request_payload IS NULL OR jsonb_typeof(request_payload)='object' AND octet_length(request_payload::text)<=40960),
  CHECK (result_payload IS NULL OR jsonb_typeof(result_payload)='object' AND octet_length(result_payload::text)<=204800)
);
ALTER TABLE paperquay.remote_retrieval_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE paperquay.remote_retrieval_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY own_account ON paperquay.remote_retrieval_requests
  USING(account_id=nullif(current_setting('paperquay.account_id',true),'')::uuid)
  WITH CHECK(account_id=nullif(current_setting('paperquay.account_id',true),'')::uuid);
REVOKE ALL ON paperquay.remote_retrieval_requests FROM PUBLIC;
CREATE FUNCTION paperquay.enforce_remote_retrieval_quota() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,paperquay AS $function$
DECLARE count_receipts bigint; count_retained bigint; used_bytes bigint; replacement_bytes bigint;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='REMOTE_RETRIEVAL_RECEIPT_IMMUTABLE'; END IF;
  PERFORM 1 FROM paperquay.accounts WHERE id=NEW.account_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='REMOTE_RETRIEVAL_ACCOUNT_REQUIRED'; END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW.account_id<>OLD.account_id OR NEW.request_id<>OLD.request_id OR NEW.requester_device_id<>OLD.requester_device_id
      OR NEW.request_digest<>OLD.request_digest OR NEW.result_digest<>OLD.result_digest OR NEW.created_at<>OLD.created_at
      OR NEW.state<>'removed' OR NEW.request_payload IS NOT NULL OR NEW.result_payload IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='REMOTE_RETRIEVAL_RECEIPT_IMMUTABLE';
    END IF;
    RETURN NEW;
  END IF;
  SELECT count(*),count(*) FILTER(WHERE state='complete'),
    coalesce(sum(coalesce(octet_length(request_payload::text),0)+coalesce(octet_length(result_payload::text),0)),0)
    INTO count_receipts,count_retained,used_bytes FROM paperquay.remote_retrieval_requests WHERE account_id=NEW.account_id;
  IF count_receipts>=256 THEN RAISE EXCEPTION USING ERRCODE='23514',CONSTRAINT='remote_retrieval_receipt_quota',MESSAGE='REMOTE_RETRIEVAL_STORAGE_FULL'; END IF;
  IF NEW.state='complete' AND count_retained>=64 THEN RAISE EXCEPTION USING ERRCODE='23514',CONSTRAINT='remote_retrieval_retained_quota',MESSAGE='REMOTE_RETRIEVAL_STORAGE_FULL'; END IF;
  replacement_bytes:=coalesce(octet_length(NEW.request_payload::text),0)+coalesce(octet_length(NEW.result_payload::text),0);
  IF used_bytes>8388608-replacement_bytes THEN RAISE EXCEPTION USING ERRCODE='23514',CONSTRAINT='remote_retrieval_byte_quota',MESSAGE='REMOTE_RETRIEVAL_STORAGE_FULL'; END IF;
  RETURN NEW;
END
$function$;
REVOKE ALL ON FUNCTION paperquay.enforce_remote_retrieval_quota() FROM PUBLIC;
CREATE TRIGGER remote_retrieval_quota BEFORE INSERT OR UPDATE OR DELETE ON paperquay.remote_retrieval_requests
  FOR EACH ROW EXECUTE FUNCTION paperquay.enforce_remote_retrieval_quota();

-- Application-account closure is atomic. Keep only a deny-rebinding marker and
-- optional per-session erasure acknowledgements; identity-provider accounts and
-- separately encrypted operator backups have their own explicit retention policy.
ALTER TABLE paperquay.accounts
  ADD COLUMN closed_at timestamptz,
  ADD COLUMN closure_request_id uuid,
  ADD COLUMN erase_devices_requested boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT account_closure_complete CHECK
    ((closed_at IS NULL AND closure_request_id IS NULL AND NOT erase_devices_requested)
      OR (closed_at IS NOT NULL AND closure_request_id IS NOT NULL));

CREATE TABLE paperquay.account_erasure_devices (
  account_id uuid NOT NULL REFERENCES paperquay.accounts(id),
  device_id uuid NOT NULL,
  session_hash bytea NOT NULL CHECK (octet_length(session_hash)=32),
  acknowledged_at timestamptz,
  PRIMARY KEY(account_id,device_id)
);
ALTER TABLE paperquay.account_erasure_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE paperquay.account_erasure_devices FORCE ROW LEVEL SECURITY;
CREATE POLICY own_account ON paperquay.account_erasure_devices
  USING(account_id=nullif(current_setting('paperquay.account_id',true),'')::uuid)
  WITH CHECK(account_id=nullif(current_setting('paperquay.account_id',true),'')::uuid);
REVOKE ALL ON paperquay.account_erasure_devices FROM PUBLIC;

-- A runtime SET of this GUC is insufficient: only the narrow erasure definer's
-- owner may enter this context. The runtime has no role membership or ownership.
CREATE FUNCTION paperquay.erasure_context_matches(owner_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $function$
  SELECT current_setting('paperquay.erasure_account',true)=owner_id::text
    AND current_user=(SELECT pg_get_userbyid(proowner) FROM pg_proc
      WHERE oid=to_regprocedure('paperquay.erase_account(uuid,uuid,text,boolean)'))
$function$;
REVOKE ALL ON FUNCTION paperquay.erasure_context_matches(uuid) FROM PUBLIC;

CREATE FUNCTION paperquay.protect_account_closure() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,paperquay AS $function$
BEGIN
  IF NOT coalesce(paperquay.erasure_context_matches(OLD.id),false)
    AND (NEW.closed_at IS DISTINCT FROM OLD.closed_at
      OR NEW.closure_request_id IS DISTINCT FROM OLD.closure_request_id
      OR NEW.erase_devices_requested IS DISTINCT FROM OLD.erase_devices_requested)
  THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='ACCOUNT_CLOSURE_IMMUTABLE'; END IF;
  RETURN NEW;
END
$function$;
REVOKE ALL ON FUNCTION paperquay.protect_account_closure() FROM PUBLIC;
CREATE TRIGGER account_closure_immutable BEFORE UPDATE ON paperquay.accounts
  FOR EACH ROW EXECUTE FUNCTION paperquay.protect_account_closure();

CREATE FUNCTION paperquay.erase_account(owner_id uuid, operation_id uuid, caller_session text, erase_devices boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,paperquay AS $function$
DECLARE owner_row paperquay.accounts%ROWTYPE;
BEGIN
  IF owner_id::text IS DISTINCT FROM current_setting('paperquay.account_id',true)
    OR operation_id IS NULL OR caller_session IS NULL OR erase_devices IS NULL
  THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='ACCOUNT_ERASURE_SCOPE_INVALID'; END IF;
  SELECT * INTO owner_row FROM paperquay.accounts WHERE id=owner_id
    AND issuer=current_setting('paperquay.issuer',true)
    AND subject=current_setting('paperquay.subject',true) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='ACCOUNT_ERASURE_SCOPE_INVALID'; END IF;
  IF owner_row.closed_at IS NOT NULL THEN
    IF owner_row.closure_request_id=operation_id THEN RETURN; END IF;
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='ACCOUNT_ALREADY_CLOSED';
  END IF;
  PERFORM 1 FROM paperquay.devices WHERE account_id=owner_id AND session_id=caller_session AND revoked_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='ACCOUNT_ERASURE_SESSION_INVALID'; END IF;
  PERFORM set_config('paperquay.erasure_account',owner_id::text,true);
  IF erase_devices THEN
    INSERT INTO paperquay.account_erasure_devices(account_id,device_id,session_hash)
      SELECT account_id,id,sha256(convert_to(session_id,'UTF8')) FROM paperquay.devices WHERE account_id=owner_id;
  END IF;
  -- FK order is explicit. No trigger, RLS policy or replication protection is
  -- disabled, and no caller-selected table or SQL is executed by this definer.
  DELETE FROM paperquay.remote_retrieval_requests WHERE account_id=owner_id;
  DELETE FROM paperquay.model_inference_jobs WHERE account_id=owner_id;
  DELETE FROM paperquay.model_inference_providers WHERE account_id=owner_id;
  DELETE FROM paperquay.remote_task_requests WHERE account_id=owner_id;
  DELETE FROM paperquay.remote_task_artifacts WHERE account_id=owner_id;
  DELETE FROM paperquay.remote_tasks WHERE account_id=owner_id;
  DELETE FROM paperquay.remote_task_providers WHERE account_id=owner_id;
  DELETE FROM paperquay.cloud_pdfs WHERE account_id=owner_id;
  DELETE FROM paperquay.conflicts WHERE account_id=owner_id;
  DELETE FROM paperquay.operation_receipts WHERE account_id=owner_id;
  DELETE FROM paperquay.changes WHERE account_id=owner_id;
  DELETE FROM paperquay.entities WHERE account_id=owner_id;
  DELETE FROM paperquay.devices WHERE account_id=owner_id;
  UPDATE paperquay.accounts SET closed_at=clock_timestamp(),closure_request_id=operation_id,
    erase_devices_requested=erase_devices,epoch=operation_id,last_seq=0,last_conflict_seq=0,
    entity_count=0,receipt_count=0,retained_bytes=0,cloud_pdf_bytes=0,cloud_pdf_count=0
    WHERE id=owner_id;
  PERFORM set_config('paperquay.erasure_account','',true);
END
$function$;
REVOKE ALL ON FUNCTION paperquay.erase_account(uuid,uuid,text,boolean) FROM PUBLIC;

CREATE FUNCTION paperquay.acknowledge_account_erasure(owner_id uuid, caller_device uuid, caller_session text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,paperquay AS $function$
BEGIN
  IF owner_id::text IS DISTINCT FROM current_setting('paperquay.account_id',true)
    OR NOT EXISTS(SELECT 1 FROM paperquay.accounts WHERE id=owner_id AND closed_at IS NOT NULL
      AND erase_devices_requested AND issuer=current_setting('paperquay.issuer',true)
      AND subject=current_setting('paperquay.subject',true))
  THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='ACCOUNT_ERASURE_SCOPE_INVALID'; END IF;
  UPDATE paperquay.account_erasure_devices SET acknowledged_at=coalesce(acknowledged_at,clock_timestamp())
    WHERE account_id=owner_id AND device_id=caller_device AND session_hash=sha256(convert_to(caller_session,'UTF8'));
  RETURN FOUND;
END
$function$;
REVOKE ALL ON FUNCTION paperquay.acknowledge_account_erasure(uuid,uuid,text) FROM PUBLIC;

-- The two existing immutable-history functions below retain their original
-- INSERT/UPDATE quotas and identity checks. Their only new exception is DELETE
-- within erase_account's verified owner context, after the user's closure request.

CREATE OR REPLACE FUNCTION paperquay.enforce_model_inference_quota() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,paperquay AS $function$
DECLARE owner_id uuid; used_count bigint; used_bytes bigint; replacement_bytes bigint;
BEGIN
 owner_id:=CASE WHEN TG_OP='DELETE' THEN OLD.account_id ELSE NEW.account_id END;
 PERFORM 1 FROM paperquay.accounts WHERE id=owner_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='MODEL_INFERENCE_ACCOUNT_REQUIRED'; END IF;
 IF TG_OP='DELETE' THEN
  IF coalesce(paperquay.erasure_context_matches(owner_id),false) THEN RETURN OLD; END IF;
  IF TG_TABLE_NAME='model_inference_jobs' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='MODEL_INFERENCE_RECEIPT_IMMUTABLE'; END IF;
  RETURN OLD;
 END IF;
 IF TG_TABLE_NAME='model_inference_providers' THEN
  SELECT count(*) INTO used_count FROM paperquay.model_inference_providers WHERE account_id=owner_id AND device_id<>NEW.device_id;
  IF used_count>=4 THEN RAISE EXCEPTION USING ERRCODE='23514',CONSTRAINT='model_inference_provider_quota',MESSAGE='MODEL_INFERENCE_PROVIDER_LIMIT'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='UPDATE' THEN
  IF NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.requester_device_id IS DISTINCT FROM OLD.requester_device_id
    OR NEW.request_digest IS DISTINCT FROM OLD.request_digest OR NEW.target IS DISTINCT FROM OLD.target OR NEW.profile IS DISTINCT FROM OLD.profile OR NEW.provider_device_id IS DISTINCT FROM OLD.provider_device_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR OLD.fence IS NOT NULL AND NEW.fence IS DISTINCT FROM OLD.fence
    OR NEW.payload_expires_at IS DISTINCT FROM OLD.payload_expires_at AND NEW.state<>'removed'
    OR OLD.input_json IS NOT NULL AND NEW.input_json IS DISTINCT FROM OLD.input_json AND NEW.state<>'removed'
    OR OLD.output_json IS NOT NULL AND NEW.output_json IS DISTINCT FROM OLD.output_json AND NEW.state<>'removed'
  THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='MODEL_INFERENCE_IDENTITY_IMMUTABLE'; END IF;
  IF NOT (NEW.state=OLD.state
    OR OLD.state='queued' AND NEW.state IN('running','failed','cancelled','removed')
    OR OLD.state='running' AND NEW.state IN('complete','failed','cancel_requested','cancelled','uncertain','removed')
    OR OLD.state='cancel_requested' AND NEW.state IN('cancelled','removed')
    OR OLD.state='uncertain' AND NEW.state IN('complete','failed','cancelled','removed')
    OR OLD.state IN('complete','failed','cancelled') AND NEW.state='removed')
  THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='MODEL_INFERENCE_NO_REEXECUTION'; END IF;
  IF OLD.fence IS NULL AND NEW.fence IS NOT NULL AND NOT (OLD.state='queued' AND NEW.state='running')
  THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='MODEL_INFERENCE_FENCE_INVALID'; END IF;
 END IF;
 IF TG_OP='INSERT' THEN
  SELECT count(*) INTO used_count FROM paperquay.model_inference_jobs WHERE account_id=owner_id;
  IF used_count>=2000 THEN RAISE EXCEPTION USING ERRCODE='23514',CONSTRAINT='model_inference_receipt_quota',MESSAGE='MODEL_INFERENCE_HISTORY_FULL'; END IF;
 END IF;
 IF NEW.request_digest IS NOT NULL AND NEW.state<>'removed' THEN
  SELECT count(*) INTO used_count FROM paperquay.model_inference_jobs WHERE account_id=owner_id AND id<>NEW.id AND request_digest IS NOT NULL AND state<>'removed';
  IF used_count>=50 THEN RAISE EXCEPTION USING ERRCODE='23514',CONSTRAINT='model_inference_retained_quota',MESSAGE='MODEL_INFERENCE_HISTORY_FULL'; END IF;
 END IF;
 IF NEW.state='queued' THEN
  SELECT count(*) INTO used_count FROM paperquay.model_inference_jobs WHERE account_id=owner_id AND id<>NEW.id AND state='queued';
  IF used_count>=4 THEN RAISE EXCEPTION USING ERRCODE='23514',CONSTRAINT='model_inference_queue_quota',MESSAGE='MODEL_INFERENCE_QUEUE_FULL'; END IF;
 END IF;
 -- Reserve an entire output envelope before dispatch. Completion replaces its reservation;
 -- another invocation cannot consume space needed to save an already paid response.
 SELECT coalesce(sum(input_bytes+output_bytes+2048+CASE WHEN request_digest IS NOT NULL AND state IN('queued','running','cancel_requested','uncertain') THEN 262144 ELSE 0 END),0)
   INTO used_bytes FROM paperquay.model_inference_jobs WHERE account_id=owner_id AND id<>NEW.id;
 replacement_bytes:=NEW.input_bytes+NEW.output_bytes+2048+CASE WHEN NEW.request_digest IS NOT NULL AND NEW.state IN('queued','running','cancel_requested','uncertain') THEN 262144 ELSE 0 END;
 IF used_bytes>16777216-replacement_bytes THEN RAISE EXCEPTION USING ERRCODE='23514',CONSTRAINT='model_inference_byte_quota',MESSAGE='MODEL_INFERENCE_STORAGE_FULL'; END IF;
 RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION paperquay.enforce_remote_retrieval_quota() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,paperquay AS $function$
DECLARE count_receipts bigint; count_retained bigint; used_bytes bigint; replacement_bytes bigint;
BEGIN
  IF TG_OP='DELETE' THEN
    IF coalesce(paperquay.erasure_context_matches(OLD.account_id),false) THEN RETURN OLD; END IF;
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='REMOTE_RETRIEVAL_RECEIPT_IMMUTABLE';
  END IF;
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

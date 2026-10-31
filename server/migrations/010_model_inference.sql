-- Chat/model invocations have independent ownership, presence, quotas and one-execution fences.
-- No PDF task target, provider credential or upstream endpoint is stored in this protocol.
CREATE TABLE paperquay.model_inference_providers (
 account_id uuid NOT NULL REFERENCES paperquay.accounts(id),
 device_id uuid NOT NULL,
 profiles jsonb NOT NULL CHECK(jsonb_typeof(profiles)='array' AND jsonb_array_length(profiles) BETWEEN 1 AND 4 AND octet_length(profiles::text)<=8192),
 expires_at timestamptz NOT NULL,
 PRIMARY KEY(account_id,device_id),
 FOREIGN KEY(account_id,device_id) REFERENCES paperquay.devices(account_id,id)
);
CREATE TABLE paperquay.model_inference_jobs (
 account_id uuid NOT NULL REFERENCES paperquay.accounts(id),
 id uuid NOT NULL,
 requester_device_id uuid NOT NULL,
 provider_device_id uuid,
 state text NOT NULL CHECK(state IN('queued','running','complete','failed','cancel_requested','cancelled','uncertain','removed')),
 target jsonb CHECK(target IS NULL OR jsonb_typeof(target)='object' AND octet_length(target::text)<=1024),
 profile jsonb CHECK(profile IS NULL OR jsonb_typeof(profile)='object' AND octet_length(profile::text)<=4096),
 request_digest text CHECK(request_digest IS NULL OR request_digest ~ '^[0-9a-f]{64}$'),
 input_json text CHECK(input_json IS NULL OR jsonb_typeof(input_json::jsonb)='object'),
 input_bytes integer NOT NULL DEFAULT 0 CHECK(input_bytes BETWEEN 0 AND 262144),
 output_json text CHECK(output_json IS NULL OR jsonb_typeof(output_json::jsonb)='object'),
 output_bytes integer NOT NULL DEFAULT 0 CHECK(output_bytes BETWEEN 0 AND 262144),
 output_digest text CHECK(output_digest IS NULL OR output_digest ~ '^[0-9a-f]{64}$'),
 fence uuid,
 lease_expires_at timestamptz,
 failure text CHECK(failure IS NULL OR failure IN('PROFILE_CHANGED','UPSTREAM_REJECTED','UPSTREAM_UNAVAILABLE','OUTCOME_UNKNOWN','OUTPUT_INVALID','OUTPUT_LIMIT','LEASE_EXPIRED','SESSION_REVOKED','EXPIRED','CANCELLED')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 payload_expires_at timestamptz,
 PRIMARY KEY(account_id,id),
 FOREIGN KEY(account_id,requester_device_id) REFERENCES paperquay.devices(account_id,id),
 FOREIGN KEY(account_id,provider_device_id) REFERENCES paperquay.devices(account_id,id),
 CHECK((input_json IS NULL AND input_bytes=0) OR input_json IS NOT NULL AND input_bytes=octet_length(input_json)),
 CHECK((output_json IS NULL AND output_bytes=0) OR output_json IS NOT NULL AND output_bytes=octet_length(output_json)),
 CHECK((state IN('running','cancel_requested'))=(lease_expires_at IS NOT NULL)),
 CHECK(state NOT IN('running','cancel_requested') OR fence IS NOT NULL),
 CHECK((state='complete')=(output_json IS NOT NULL AND output_digest IS NOT NULL AND output_bytes>0)),
 CHECK(state='complete' OR output_json IS NULL AND output_digest IS NULL AND output_bytes=0),
 CHECK(state<>'complete' OR failure IS NULL),
 CHECK((request_digest IS NULL AND state='cancelled' AND target IS NULL AND profile IS NULL AND provider_device_id IS NULL AND input_json IS NULL AND fence IS NULL AND payload_expires_at IS NULL)
    OR (request_digest IS NOT NULL AND target IS NOT NULL AND profile IS NOT NULL
      AND ((target->>'kind'='gateway' AND provider_device_id IS NULL) OR (target->>'kind'='computer' AND provider_device_id IS NOT NULL AND target->>'deviceId'=provider_device_id::text))
      AND ((state='removed' AND input_json IS NULL AND payload_expires_at IS NULL) OR (state<>'removed' AND input_json IS NOT NULL AND payload_expires_at IS NOT NULL)))),
 CHECK(request_digest IS NULL OR (target->>'kind' IN('gateway','computer')) IS TRUE),
 CHECK(provider_device_id IS NULL OR (target->>'kind'='computer' AND target->>'deviceId'=provider_device_id::text) IS TRUE),
 CHECK(request_digest IS NULL OR ((target->>'kind'='gateway')=(provider_device_id IS NULL)) IS TRUE),
 CHECK(request_digest IS NULL OR (profile->>'kind'='chat') IS TRUE),
 CHECK(payload_expires_at IS NULL OR payload_expires_at>created_at AND payload_expires_at<=created_at+interval '24 hours')
);
CREATE UNIQUE INDEX model_inference_one_active ON paperquay.model_inference_jobs(account_id) WHERE state IN('running','cancel_requested');
CREATE INDEX model_inference_claim_queue ON paperquay.model_inference_jobs(account_id,provider_device_id,created_at,id) WHERE state='queued';
CREATE INDEX model_inference_payload_expiry ON paperquay.model_inference_jobs(account_id,payload_expires_at) WHERE payload_expires_at IS NOT NULL;
DO $policy$
DECLARE table_name text;
BEGIN
 FOREACH table_name IN ARRAY ARRAY['model_inference_providers','model_inference_jobs'] LOOP
  EXECUTE format('ALTER TABLE paperquay.%I ENABLE ROW LEVEL SECURITY',table_name);
  EXECUTE format('ALTER TABLE paperquay.%I FORCE ROW LEVEL SECURITY',table_name);
  EXECUTE format('CREATE POLICY own_account ON paperquay.%I USING (account_id=nullif(current_setting(''paperquay.account_id'',true),'''')::uuid) WITH CHECK (account_id=nullif(current_setting(''paperquay.account_id'',true),'''')::uuid)',table_name);
  EXECUTE format('REVOKE ALL ON paperquay.%I FROM PUBLIC',table_name);
 END LOOP;
END
$policy$;
CREATE FUNCTION paperquay.enforce_model_inference_quota() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,paperquay AS $function$
DECLARE owner_id uuid; used_count bigint; used_bytes bigint; replacement_bytes bigint;
BEGIN
 owner_id:=CASE WHEN TG_OP='DELETE' THEN OLD.account_id ELSE NEW.account_id END;
 PERFORM 1 FROM paperquay.accounts WHERE id=owner_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='MODEL_INFERENCE_ACCOUNT_REQUIRED'; END IF;
 IF TG_OP='DELETE' THEN
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
REVOKE ALL ON FUNCTION paperquay.enforce_model_inference_quota() FROM PUBLIC;
CREATE TRIGGER model_inference_providers_quota BEFORE INSERT OR UPDATE OR DELETE ON paperquay.model_inference_providers FOR EACH ROW EXECUTE FUNCTION paperquay.enforce_model_inference_quota();
CREATE TRIGGER model_inference_jobs_quota BEFORE INSERT OR UPDATE OR DELETE ON paperquay.model_inference_jobs FOR EACH ROW EXECUTE FUNCTION paperquay.enforce_model_inference_quota();

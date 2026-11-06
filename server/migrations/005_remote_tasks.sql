-- Remote execution is not a sync entity. All transitions and artifacts use the
-- same account transaction lock as sync, including across server processes.
CREATE TABLE paperquay.remote_task_providers (
  account_id uuid NOT NULL REFERENCES paperquay.accounts(id),
  device_id uuid NOT NULL,
  profiles jsonb NOT NULL CHECK (jsonb_typeof(profiles) = 'array' AND jsonb_array_length(profiles) <= 8
    AND octet_length(profiles::text) <= 8192),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, device_id),
  FOREIGN KEY (account_id, device_id) REFERENCES paperquay.devices(account_id, id)
);
CREATE TABLE paperquay.remote_tasks (
  account_id uuid NOT NULL REFERENCES paperquay.accounts(id),
  id uuid NOT NULL,
  requester_device_id uuid NOT NULL,
  provider_device_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('parse', 'index')),
  state text NOT NULL CHECK (state IN ('queued','running','succeeded','failed','cancel_requested','cancelled','interrupted')),
  target jsonb NOT NULL CHECK (jsonb_typeof(target) = 'object' AND octet_length(target::text) <= 4096),
  profile jsonb NOT NULL CHECK (jsonb_typeof(profile) = 'object' AND octet_length(profile::text) <= 2048),
  index_source_digest text CHECK (index_source_digest ~ '^[0-9a-f]{64}$'),
  dedupe_digest text NOT NULL CHECK (dedupe_digest ~ '^[0-9a-f]{64}$'),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt BETWEEN 0 AND 100),
  fence uuid,
  lease_expires_at timestamptz,
  failure text CHECK (failure IN ('EXECUTION_FAILED','SOURCE_UNAVAILABLE','PROFILE_CHANGED','EXTERNAL_OUTCOME_UNKNOWN',
    'LEASE_EXPIRED','SESSION_REVOKED','VERSION_CHANGED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, id),
  UNIQUE (account_id, dedupe_digest),
  FOREIGN KEY (account_id, requester_device_id) REFERENCES paperquay.devices(account_id, id),
  FOREIGN KEY (account_id, provider_device_id) REFERENCES paperquay.devices(account_id, id),
  CHECK ((kind = 'index') = (index_source_digest IS NOT NULL)),
  CHECK ((state IN ('running','cancel_requested')) = (fence IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK (state NOT IN ('running','cancel_requested') OR attempt > 0)
);
CREATE UNIQUE INDEX remote_task_one_active ON paperquay.remote_tasks(account_id)
  WHERE state IN ('running','cancel_requested');
CREATE INDEX remote_task_claim_queue ON paperquay.remote_tasks(account_id, provider_device_id, created_at, id)
  WHERE state = 'queued';
-- A deleted task leaves a request tombstone. An old request can never silently
-- create another paid execution. The bounded receipt budget does not auto-evict.
CREATE TABLE paperquay.remote_task_requests (
  account_id uuid NOT NULL REFERENCES paperquay.accounts(id),
  request_id uuid NOT NULL,
  input_digest text NOT NULL CHECK (input_digest ~ '^[0-9a-f]{64}$'),
  job_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, request_id),
  FOREIGN KEY (account_id, job_id) REFERENCES paperquay.remote_tasks(account_id, id)
);
CREATE TABLE paperquay.remote_task_artifacts (
  account_id uuid NOT NULL,
  job_id uuid NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 16777216),
  content bytea NOT NULL,
  completion_fence uuid NOT NULL,
  PRIMARY KEY (account_id, job_id),
  FOREIGN KEY (account_id, job_id) REFERENCES paperquay.remote_tasks(account_id, id) ON DELETE CASCADE,
  CHECK (octet_length(content) = size_bytes),
  CHECK (encode(pg_catalog.sha256(content), 'hex') = digest)
);
DO $policy$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['remote_task_providers','remote_tasks','remote_task_requests','remote_task_artifacts'] LOOP
    EXECUTE format('ALTER TABLE paperquay.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE paperquay.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY own_account ON paperquay.%I USING (account_id = nullif(current_setting(''paperquay.account_id'', true), '''')::uuid) WITH CHECK (account_id = nullif(current_setting(''paperquay.account_id'', true), '''')::uuid)', table_name);
    EXECUTE format('REVOKE ALL ON paperquay.%I FROM PUBLIC', table_name);
  END LOOP;
END
$policy$;
CREATE FUNCTION paperquay.enforce_remote_task_quota() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, paperquay AS $function$
DECLARE owner_id uuid; used_count bigint; used_bytes bigint;
BEGIN
  owner_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.account_id ELSE NEW.account_id END;
  PERFORM 1 FROM paperquay.accounts WHERE id = owner_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'REMOTE_TASK_ACCOUNT_REQUIRED'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF TG_TABLE_NAME = 'remote_tasks' THEN
    IF TG_OP = 'INSERT' THEN
      SELECT count(*) INTO used_count FROM paperquay.remote_tasks WHERE account_id = owner_id;
      IF used_count >= 200 THEN RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'remote_task_retained_quota', MESSAGE = 'REMOTE_TASK_HISTORY_FULL'; END IF;
    END IF;
    IF NEW.state = 'queued' THEN
      SELECT count(*) INTO used_count FROM paperquay.remote_tasks WHERE account_id = owner_id AND state = 'queued' AND id <> NEW.id;
      IF used_count >= 16 THEN RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'remote_task_queue_quota', MESSAGE = 'REMOTE_TASK_QUEUE_FULL'; END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'remote_task_requests' AND TG_OP = 'INSERT' THEN
    SELECT count(*) INTO used_count FROM paperquay.remote_task_requests WHERE account_id = owner_id;
    IF used_count >= 2000 THEN RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'remote_task_receipt_quota', MESSAGE = 'REMOTE_TASK_HISTORY_FULL'; END IF;
  ELSIF TG_TABLE_NAME = 'remote_task_artifacts' THEN
    IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'REMOTE_TASK_ARTIFACT_IMMUTABLE'; END IF;
    SELECT coalesce(sum(size_bytes), 0) INTO used_bytes FROM paperquay.remote_task_artifacts WHERE account_id = owner_id;
    IF used_bytes > 67108864 - NEW.size_bytes THEN RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'remote_task_artifact_quota', MESSAGE = 'REMOTE_TASK_ARTIFACT_QUOTA'; END IF;
  END IF;
  RETURN NEW;
END
$function$;
REVOKE ALL ON FUNCTION paperquay.enforce_remote_task_quota() FROM PUBLIC;
CREATE TRIGGER remote_tasks_quota BEFORE INSERT OR UPDATE OR DELETE ON paperquay.remote_tasks
  FOR EACH ROW EXECUTE FUNCTION paperquay.enforce_remote_task_quota();
CREATE TRIGGER remote_requests_quota BEFORE INSERT OR UPDATE OR DELETE ON paperquay.remote_task_requests
  FOR EACH ROW EXECUTE FUNCTION paperquay.enforce_remote_task_quota();
CREATE TRIGGER remote_artifacts_quota BEFORE INSERT OR UPDATE OR DELETE ON paperquay.remote_task_artifacts
  FOR EACH ROW EXECUTE FUNCTION paperquay.enforce_remote_task_quota();

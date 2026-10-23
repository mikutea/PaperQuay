CREATE TABLE paperquay.accounts (
  id uuid PRIMARY KEY,
  issuer text NOT NULL CHECK (length(issuer) BETWEEN 1 AND 2048),
  subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 255),
  epoch uuid NOT NULL,
  last_seq bigint NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
  last_conflict_seq bigint NOT NULL DEFAULT 0 CHECK (last_conflict_seq >= 0),
  entity_count integer NOT NULL DEFAULT 0 CHECK (entity_count >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (issuer, subject)
);

CREATE TABLE paperquay.devices (
  account_id uuid NOT NULL REFERENCES paperquay.accounts(id),
  id uuid NOT NULL,
  session_id text NOT NULL CHECK (length(session_id) BETWEEN 1 AND 512),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  platform text NOT NULL CHECK (platform IN ('web', 'windows', 'macos', 'linux', 'ios', 'android')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  PRIMARY KEY (account_id, id),
  UNIQUE (account_id, session_id)
);

CREATE TABLE paperquay.entities (
  account_id uuid NOT NULL REFERENCES paperquay.accounts(id),
  entity_type text NOT NULL CHECK (entity_type IN ('paper', 'attachmentVersion', 'note', 'annotation', 'readingPosition')),
  entity_id uuid NOT NULL,
  schema_version integer NOT NULL CHECK (schema_version = 1),
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  -- Retained behind the tombstone to enforce immutable attachment and checkpoint bindings.
  -- Wire tombstones always expose data:null, never this retained body.
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  deleted_at timestamptz,
  updated_at timestamptz NOT NULL,
  created_by_device_id uuid NOT NULL,
  modified_by_device_id uuid NOT NULL,
  PRIMARY KEY (account_id, entity_type, entity_id),
  FOREIGN KEY (account_id, created_by_device_id) REFERENCES paperquay.devices(account_id, id),
  FOREIGN KEY (account_id, modified_by_device_id) REFERENCES paperquay.devices(account_id, id)
);

CREATE UNIQUE INDEX one_checkpoint_per_device_version
  ON paperquay.entities (account_id, created_by_device_id, (data ->> 'attachmentVersionId'))
  WHERE entity_type = 'readingPosition';

CREATE TABLE paperquay.changes (
  account_id uuid NOT NULL REFERENCES paperquay.accounts(id),
  seq bigint NOT NULL CHECK (seq >= 1),
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, seq),
  FOREIGN KEY (account_id, entity_type, entity_id)
    REFERENCES paperquay.entities(account_id, entity_type, entity_id)
);

CREATE TABLE paperquay.operation_receipts (
  account_id uuid NOT NULL REFERENCES paperquay.accounts(id),
  op_id uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, op_id)
);

CREATE TABLE paperquay.conflicts (
  account_id uuid NOT NULL REFERENCES paperquay.accounts(id),
  id uuid NOT NULL,
  seq bigint NOT NULL CHECK (seq >= 1),
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  attempted_operation jsonb NOT NULL CHECK (jsonb_typeof(attempted_operation) = 'object'),
  observed_record jsonb NOT NULL CHECK (jsonb_typeof(observed_record) = 'object'),
  created_by_device_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz,
  resolution_op_id uuid,
  PRIMARY KEY (account_id, id),
  UNIQUE (account_id, seq),
  FOREIGN KEY (account_id, entity_type, entity_id)
    REFERENCES paperquay.entities(account_id, entity_type, entity_id),
  FOREIGN KEY (account_id, created_by_device_id) REFERENCES paperquay.devices(account_id, id),
  CHECK ((resolved_at IS NULL) = (resolution_op_id IS NULL))
);
CREATE INDEX unresolved_conflicts ON paperquay.conflicts(account_id, seq) WHERE resolved_at IS NULL;

ALTER TABLE paperquay.accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE paperquay.accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY own_identity ON paperquay.accounts
  USING (issuer = current_setting('paperquay.issuer', true)
     AND subject = current_setting('paperquay.subject', true))
  WITH CHECK (issuer = current_setting('paperquay.issuer', true)
     AND subject = current_setting('paperquay.subject', true));

DO $policy$
DECLARE object_name text;
BEGIN
  FOREACH object_name IN ARRAY ARRAY['devices', 'entities', 'changes', 'operation_receipts', 'conflicts']
  LOOP
    EXECUTE format('ALTER TABLE paperquay.%I ENABLE ROW LEVEL SECURITY', object_name);
    EXECUTE format('ALTER TABLE paperquay.%I FORCE ROW LEVEL SECURITY', object_name);
    EXECUTE format(
      'CREATE POLICY own_account ON paperquay.%I USING (account_id = nullif(current_setting(''paperquay.account_id'', true), '''')::uuid) WITH CHECK (account_id = nullif(current_setting(''paperquay.account_id'', true), '''')::uuid)',
      object_name
    );
  END LOOP;
END
$policy$;

REVOKE ALL ON ALL TABLES IN SCHEMA paperquay FROM PUBLIC;

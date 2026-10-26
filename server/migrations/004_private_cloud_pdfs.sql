-- PDF payload accounting is independent of retained sync JSON. All state lives
-- in this database transaction; an interrupted write cannot leave a file orphan.
ALTER TABLE paperquay.accounts ADD COLUMN cloud_pdf_bytes bigint NOT NULL DEFAULT 0
  CHECK (cloud_pdf_bytes BETWEEN 0 AND 10737418240);
ALTER TABLE paperquay.accounts ADD COLUMN cloud_pdf_count integer NOT NULL DEFAULT 0
  CHECK (cloud_pdf_count BETWEEN 0 AND 512);
-- A delete invalidates an upload admitted before it, even when no copy existed.
-- This bounded internal field is never part of a sync record or change event.
ALTER TABLE paperquay.entities ADD COLUMN cloud_pdf_generation bigint NOT NULL DEFAULT 0
  CHECK (cloud_pdf_generation BETWEEN 0 AND 9007199254740991);

CREATE TABLE paperquay.cloud_pdfs (
  account_id uuid NOT NULL REFERENCES paperquay.accounts(id),
  attachment_version_id uuid NOT NULL,
  attachment_entity_type text NOT NULL DEFAULT 'attachmentVersion' CHECK (attachment_entity_type = 'attachmentVersion'),
  paper_id uuid NOT NULL,
  paper_entity_type text NOT NULL DEFAULT 'paper' CHECK (paper_entity_type = 'paper'),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 67108864),
  file_name text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 255),
  content bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, attachment_version_id),
  FOREIGN KEY (account_id, attachment_entity_type, attachment_version_id)
    REFERENCES paperquay.entities(account_id, entity_type, entity_id),
  FOREIGN KEY (account_id, paper_entity_type, paper_id)
    REFERENCES paperquay.entities(account_id, entity_type, entity_id),
  CHECK (octet_length(content) = size_bytes),
  CHECK (encode(pg_catalog.sha256(content), 'hex') = sha256)
);

ALTER TABLE paperquay.cloud_pdfs ENABLE ROW LEVEL SECURITY;
ALTER TABLE paperquay.cloud_pdfs FORCE ROW LEVEL SECURITY;
CREATE POLICY own_account ON paperquay.cloud_pdfs
  USING (account_id = nullif(current_setting('paperquay.account_id', true), '')::uuid)
  WITH CHECK (account_id = nullif(current_setting('paperquay.account_id', true), '')::uuid);

CREATE FUNCTION paperquay.enforce_cloud_pdf_quota() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, paperquay AS $function$
DECLARE
  owner_id uuid;
  used_bytes bigint;
  used_copies integer;
  byte_limit bigint;
  version_data jsonb;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'CLOUD_PDF_IMMUTABLE';
  END IF;
  owner_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.account_id ELSE NEW.account_id END;
  SELECT cloud_pdf_bytes, cloud_pdf_count INTO used_bytes, used_copies
    FROM paperquay.accounts WHERE id = owner_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'CLOUD_PDF_ACCOUNT_REQUIRED';
  END IF;
  IF TG_OP = 'DELETE' THEN
    UPDATE paperquay.accounts SET cloud_pdf_bytes = cloud_pdf_bytes - OLD.size_bytes,
      cloud_pdf_count = cloud_pdf_count - 1 WHERE id = owner_id;
    RETURN OLD;
  END IF;
  SELECT version.data INTO version_data FROM paperquay.entities version
    JOIN paperquay.entities paper ON paper.account_id = version.account_id
      AND paper.entity_type = 'paper' AND paper.entity_id = NEW.paper_id
    WHERE version.account_id = owner_id AND version.entity_type = 'attachmentVersion'
      AND version.entity_id = NEW.attachment_version_id
      AND version.deleted_at IS NULL AND paper.deleted_at IS NULL;
  IF NOT FOUND OR version_data ->> 'paperId' <> NEW.paper_id::text
    OR version_data ->> 'sha256' <> NEW.sha256
    OR (version_data ->> 'sizeBytes')::bigint <> NEW.size_bytes
    OR version_data ->> 'mediaType' <> 'application/pdf' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'CLOUD_PDF_VERSION_REQUIRED';
  END IF;
  byte_limit := coalesce(nullif(current_setting('paperquay.cloud_pdf_byte_limit', true), '')::bigint, 1073741824);
  IF byte_limit < 1 OR byte_limit > 10737418240 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'CLOUD_PDF_LIMIT_INVALID';
  END IF;
  IF used_copies >= 512 OR used_bytes > byte_limit - NEW.size_bytes THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'CLOUD_PDF_QUOTA_EXCEEDED',
      CONSTRAINT = 'paperquay_cloud_pdf_quota';
  END IF;
  UPDATE paperquay.accounts SET cloud_pdf_bytes = cloud_pdf_bytes + NEW.size_bytes,
    cloud_pdf_count = cloud_pdf_count + 1 WHERE id = owner_id;
  RETURN NEW;
END
$function$;
REVOKE ALL ON FUNCTION paperquay.enforce_cloud_pdf_quota() FROM PUBLIC;
CREATE TRIGGER cloud_pdf_quota BEFORE INSERT OR UPDATE OR DELETE ON paperquay.cloud_pdfs
  FOR EACH ROW EXECUTE FUNCTION paperquay.enforce_cloud_pdf_quota();
REVOKE ALL ON paperquay.cloud_pdfs FROM PUBLIC;

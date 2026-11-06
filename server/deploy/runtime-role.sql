-- Reference only. Run as an authorized migration/admin role after migrations.
-- Create paperquay_runtime with LOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE,
-- NOINHERIT, NOREPLICATION, NOBYPASSRLS and a separately provisioned password.
-- The runtime role must not own this schema or its tables and must not be a
-- member of the migration/owner role. Do not grant schema CREATE or TRUNCATE.
GRANT USAGE ON SCHEMA paperquay TO paperquay_runtime;
GRANT SELECT ON paperquay.schema_migrations TO paperquay_runtime;
GRANT SELECT, INSERT, UPDATE ON paperquay.accounts TO paperquay_runtime;
GRANT SELECT, INSERT, UPDATE ON paperquay.devices TO paperquay_runtime;
GRANT SELECT, INSERT, UPDATE ON paperquay.entities TO paperquay_runtime;
GRANT SELECT, INSERT ON paperquay.changes TO paperquay_runtime;
GRANT SELECT, INSERT ON paperquay.operation_receipts TO paperquay_runtime;
GRANT SELECT, INSERT, UPDATE ON paperquay.conflicts TO paperquay_runtime;
GRANT SELECT, INSERT, DELETE ON paperquay.cloud_pdfs TO paperquay_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON paperquay.remote_task_providers, paperquay.remote_tasks, paperquay.remote_task_artifacts TO paperquay_runtime;
GRANT SELECT, INSERT ON paperquay.remote_task_requests TO paperquay_runtime;
GRANT UPDATE (job_id) ON paperquay.remote_task_requests TO paperquay_runtime;

-- Row security is defense in depth. The trusted API establishes transaction-
-- local issuer, subject, and account settings from validated OIDC claims.
-- Database credentials and direct SQL access must never be given to clients.
-- Retained-byte triggers use these existing privileges as SECURITY INVOKER.
-- Their transaction-local quota is supplied only by trusted API configuration;
-- do not grant schema ownership, trigger management, or history deletion.
-- This reference does not establish that a production deployment was audited.

-- Model payload deletion leaves an immutable request-ID tombstone; the runtime
-- can clear content by UPDATE but cannot delete billing/dispatch identities.
GRANT SELECT, INSERT, UPDATE, DELETE ON paperquay.model_inference_providers TO paperquay_runtime;
GRANT SELECT, INSERT, UPDATE ON paperquay.model_inference_jobs TO paperquay_runtime;

-- Retrieval content may be cleared, but neither old request identities nor results can be rewritten or deleted.
GRANT SELECT, INSERT ON paperquay.remote_retrieval_requests TO paperquay_runtime;
GRANT UPDATE (state,request_payload,result_payload) ON paperquay.remote_retrieval_requests TO paperquay_runtime;

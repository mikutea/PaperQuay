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

-- Row security is defense in depth. The trusted API establishes transaction-
-- local issuer, subject, and account settings from validated OIDC claims.
-- Database credentials and direct SQL access must never be given to clients.
-- This reference does not establish that a production deployment was audited.

-- Fresh, dedicated cluster only. Never run against an existing shared database.
\getenv migration_password PAPERQUAY_MIGRATION_DB_PASSWORD
\getenv runtime_password PAPERQUAY_RUNTIME_DB_PASSWORD
\getenv erasure_password PAPERQUAY_ERASURE_DB_PASSWORD
\getenv identity_password PAPERQUAY_IDENTITY_DB_PASSWORD
CREATE ROLE paperquay_migrate LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS
  PASSWORD :'migration_password';
CREATE ROLE paperquay_erasure LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS
  PASSWORD :'erasure_password';
CREATE ROLE paperquay_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS
  PASSWORD :'runtime_password';
CREATE ROLE paperquay_identity LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS
  PASSWORD :'identity_password';
CREATE DATABASE paperquay OWNER paperquay_migrate;
CREATE DATABASE paperquay_identity OWNER paperquay_identity;
REVOKE ALL ON DATABASE paperquay, paperquay_identity FROM PUBLIC;
GRANT CONNECT ON DATABASE paperquay TO paperquay_runtime, paperquay_erasure;
\connect paperquay
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
\connect paperquay_identity
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

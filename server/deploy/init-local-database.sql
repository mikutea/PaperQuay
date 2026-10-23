-- Consumed only by the optional disposable PostgreSQL container on first init.
-- psql reads secrets from the container environment without embedding them in
-- this file or command arguments. Do not run with --echo-all/--echo-queries.
\getenv migration_password PAPERQUAY_MIGRATION_DB_PASSWORD
\getenv runtime_password PAPERQUAY_RUNTIME_DB_PASSWORD
CREATE ROLE paperquay_migrate LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS
  PASSWORD :'migration_password';
CREATE ROLE paperquay_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS
  PASSWORD :'runtime_password';
ALTER DATABASE paperquay_sync_test OWNER TO paperquay_migrate;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE paperquay_sync_test TO paperquay_migrate, paperquay_runtime;

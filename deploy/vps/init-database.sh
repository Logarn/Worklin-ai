#!/bin/sh
set -eu
: "${WORKLIN_DB_RUNTIME_PASSWORD:?Set runtime database password}"
: "${WORKLIN_DB_MIGRATOR_PASSWORD:?Set migrator database password}"
: "${WORKLIN_RETENTION_DB_RUNTIME_PASSWORD:?Set retention runtime database password}"
: "${WORKLIN_RETENTION_DB_MIGRATOR_PASSWORD:?Set retention migrator database password}"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=runtime_credential="$WORKLIN_DB_RUNTIME_PASSWORD" \
  --set=migrator_credential="$WORKLIN_DB_MIGRATOR_PASSWORD" \
  --set=retention_runtime_credential="$WORKLIN_RETENTION_DB_RUNTIME_PASSWORD" \
  --set=retention_migrator_credential="$WORKLIN_RETENTION_DB_MIGRATOR_PASSWORD" <<'SQL'
CREATE ROLE worklin_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
SELECT format('ALTER ROLE worklin_migrator PASSWORD %L', :'migrator_credential') \gexec
CREATE ROLE worklin_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
SELECT format('ALTER ROLE worklin_runtime PASSWORD %L', :'runtime_credential') \gexec
REVOKE ALL ON DATABASE worklin FROM PUBLIC;
GRANT CONNECT ON DATABASE worklin TO worklin_migrator, worklin_runtime;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO worklin_migrator;
GRANT USAGE ON SCHEMA public TO worklin_runtime;
CREATE ROLE worklin_retention_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
SELECT format('ALTER ROLE worklin_retention_migrator PASSWORD %L', :'retention_migrator_credential') \gexec
CREATE ROLE worklin_retention_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
SELECT format('ALTER ROLE worklin_retention_runtime PASSWORD %L', :'retention_runtime_credential') \gexec
CREATE DATABASE worklin_retention;
REVOKE ALL ON DATABASE worklin_retention FROM PUBLIC;
GRANT CONNECT ON DATABASE worklin_retention TO worklin_retention_migrator, worklin_retention_runtime;
\connect worklin_retention
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO worklin_retention_migrator;
GRANT USAGE ON SCHEMA public TO worklin_retention_runtime;
SQL

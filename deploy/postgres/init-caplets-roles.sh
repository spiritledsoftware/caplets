#!/bin/sh
set -eu

: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${CAPLETS_POSTGRES_MIGRATOR_PASSWORD:?CAPLETS_POSTGRES_MIGRATOR_PASSWORD is required}"
: "${CAPLETS_POSTGRES_RUNTIME_PASSWORD:?CAPLETS_POSTGRES_RUNTIME_PASSWORD is required}"

schema=${CAPLETS_POSTGRES_SCHEMA:-caplets}
case "$schema" in
  [a-z_]* ) ;;
  * ) echo "CAPLETS_POSTGRES_SCHEMA must start with a lowercase letter or underscore" >&2; exit 1 ;;
esac
case "$schema" in
  *[!a-z0-9_]* ) echo "CAPLETS_POSTGRES_SCHEMA contains an invalid character" >&2; exit 1 ;;
esac
if [ "${#schema}" -gt 63 ]; then
  echo "CAPLETS_POSTGRES_SCHEMA must not exceed 63 characters" >&2
  exit 1
fi

psql --set=ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --set=database="$POSTGRES_DB" \
  --set=schema="$schema" \
  --set=migrator_password="$CAPLETS_POSTGRES_MIGRATOR_PASSWORD" \
  --set=runtime_password="$CAPLETS_POSTGRES_RUNTIME_PASSWORD" <<'SQL'
REVOKE ALL ON DATABASE :"database" FROM PUBLIC;

CREATE ROLE caplets_migrator LOGIN NOINHERIT PASSWORD :'migrator_password';
CREATE ROLE caplets_runtime LOGIN NOINHERIT PASSWORD :'runtime_password';

GRANT CONNECT, CREATE ON DATABASE :"database" TO caplets_migrator;
GRANT CONNECT ON DATABASE :"database" TO caplets_runtime;

CREATE SCHEMA :"schema" AUTHORIZATION caplets_migrator;
REVOKE ALL ON SCHEMA :"schema" FROM PUBLIC;
GRANT USAGE ON SCHEMA :"schema" TO caplets_runtime;

ALTER ROLE caplets_migrator IN DATABASE :"database" SET search_path TO :"schema";
ALTER ROLE caplets_runtime IN DATABASE :"database" SET search_path TO :"schema";

ALTER DEFAULT PRIVILEGES FOR ROLE caplets_migrator IN SCHEMA :"schema"
  REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE caplets_migrator IN SCHEMA :"schema"
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO caplets_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE caplets_migrator IN SCHEMA :"schema"
  REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE caplets_migrator IN SCHEMA :"schema"
  GRANT USAGE, SELECT ON SEQUENCES TO caplets_runtime;
SQL

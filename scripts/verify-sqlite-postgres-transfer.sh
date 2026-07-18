#!/bin/sh
set -eu

PGLOADER_IMAGE=${PGLOADER_IMAGE:-ghcr.io/dimitri/pgloader@sha256:f4d2e2d7229980516da69b1eb73d9e11f97fb567fce7421f5a0bc70cbe6c76bf}
PSQL_IMAGE=${PSQL_IMAGE:-postgres:17.6-bookworm}
schema=${CAPLETS_POSTGRES_SCHEMA:-caplets}

fail() {
  echo "error: $*" >&2
  exit 1
}

[ "${CAPLETS_SQL_TRANSFER_CONFIRM:-}" = "offline-empty-target" ] || fail \
  "set CAPLETS_SQL_TRANSFER_CONFIRM=offline-empty-target after stopping every Host Node and preparing an empty migrated target"
: "${CAPLETS_SQLITE_SNAPSHOT:?CAPLETS_SQLITE_SNAPSHOT must name the offline SQLite backup}"
: "${CAPLETS_TEST_POSTGRES_URL:?CAPLETS_TEST_POSTGRES_URL must use the target data-transfer role}"
[ -f "$CAPLETS_SQLITE_SNAPSHOT" ] || fail "SQLite snapshot not found: $CAPLETS_SQLITE_SNAPSHOT"

for command in sqlite3 docker; do
  command -v "$command" >/dev/null 2>&1 || fail "$command is required"
done
if ! command -v psql >/dev/null 2>&1; then
  psql() {
    docker run --rm --network host "$PSQL_IMAGE" psql "$@"
  }
fi

case "$schema" in
  [a-z_]* ) ;;
  * ) fail "CAPLETS_POSTGRES_SCHEMA must start with a lowercase letter or underscore" ;;
esac
case "$schema" in
  *[!a-z0-9_]* ) fail "CAPLETS_POSTGRES_SCHEMA contains an invalid character" ;;
esac
[ "${#schema}" -le 63 ] || fail "CAPLETS_POSTGRES_SCHEMA must not exceed 63 characters"
case "$CAPLETS_TEST_POSTGRES_URL" in
  *"
"* ) fail "CAPLETS_TEST_POSTGRES_URL must not contain a newline" ;;
esac

work=$(mktemp -d "${TMPDIR:-/tmp}/caplets-sql-transfer.XXXXXX")
trap 'rm -rf "$work"' EXIT HUP INT TERM
chmod 700 "$work"
cp "$CAPLETS_SQLITE_SNAPSHOT" "$work/source.sqlite3"
chmod 600 "$work/source.sqlite3"

integrity=$(sqlite3 "$work/source.sqlite3" 'PRAGMA integrity_check;')
[ "$integrity" = "ok" ] || fail "SQLite integrity_check failed: $integrity"
foreign_key_errors=$(sqlite3 "$work/source.sqlite3" 'PRAGMA foreign_key_check;')
[ -z "$foreign_key_errors" ] || fail "SQLite foreign_key_check reported violations"

source_version=$(sqlite3 "$work/source.sqlite3" \
  'SELECT version FROM caplets_schema WHERE singleton = 1;')
target_schema=$(psql "$CAPLETS_TEST_POSTGRES_URL" -X -qAt -v ON_ERROR_STOP=1 \
  -c 'SELECT current_schema();')
[ "$target_schema" = "$schema" ] || fail \
  "target role current_schema() is $target_schema, expected $schema; set its database search_path before loading"
target_version=$(psql "$CAPLETS_TEST_POSTGRES_URL" -X -qAt -v ON_ERROR_STOP=1 \
  -c "SELECT version FROM \"$schema\".caplets_schema WHERE singleton = 1;")
[ -n "$source_version" ] || fail "source schema version is missing"
[ "$source_version" = "$target_version" ] || fail \
  "released schema versions differ (SQLite $source_version, PostgreSQL $target_version)"

source_tables=$(sqlite3 "$work/source.sqlite3" \
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('caplets_migrations', 'caplets_schema') ORDER BY name;")
target_tables=$(psql "$CAPLETS_TEST_POSTGRES_URL" -X -qAt -v ON_ERROR_STOP=1 \
  -c "SELECT table_name FROM information_schema.tables WHERE table_schema = '$schema' AND table_type = 'BASE TABLE' AND table_name NOT IN ('caplets_migrations', 'caplets_schema') ORDER BY table_name;")
[ "$source_tables" = "$target_tables" ] || {
  echo "SQLite application tables:" >&2
  echo "$source_tables" >&2
  echo "PostgreSQL application tables:" >&2
  echo "$target_tables" >&2
  fail "source and target application table sets differ"
}

for table in $target_tables; do
  case "$table" in
    [a-z_]* ) ;;
    * ) fail "unexpected target table name: $table" ;;
  esac
  case "$table" in
    *[!a-z0-9_]* ) fail "unexpected target table name: $table" ;;
  esac
  rows=$(psql "$CAPLETS_TEST_POSTGRES_URL" -X -qAt -v ON_ERROR_STOP=1 \
    -c "SELECT count(*) FROM \"$schema\".\"$table\";")
  [ "$rows" = "0" ] || fail "target table $schema.$table is not empty ($rows rows)"
done

load_file="$work/sqlite-data-only.load"
: >"$load_file"
loaded_tables=" "
remaining_tables=$source_tables
while [ -n "$remaining_tables" ]; do
  ready_tables=
  for table in $remaining_tables; do
    dependencies=$(sqlite3 "$work/source.sqlite3" \
      "SELECT DISTINCT \"table\" FROM pragma_foreign_key_list('$table') WHERE \"table\" <> '$table' AND \"table\" NOT IN ('caplets_migrations', 'caplets_schema') ORDER BY \"table\";")
    blocked=false
    for dependency in $dependencies; do
      case "$loaded_tables" in
        *" $dependency "* ) ;;
        * ) blocked=true ;;
      esac
    done
    [ "$blocked" = true ] || ready_tables="$ready_tables $table"
  done
  [ -n "$ready_tables" ] || fail "application table foreign keys contain a dependency cycle"

  next_remaining=
  for table in $remaining_tables; do
    case " $ready_tables " in
      *" $table "* ) ;;
      * ) next_remaining="$next_remaining $table" ;;
    esac
  done
  remaining_tables=$next_remaining

  for table in $ready_tables; do
    cat >>"$load_file" <<EOF
LOAD DATABASE
     FROM sqlite:///work/source.sqlite3
     INTO $CAPLETS_TEST_POSTGRES_URL

 WITH data only,
      include no drop,
      no truncate,
      reset no sequences,
      no foreign keys,
      downcase identifiers

 INCLUDING ONLY TABLE NAMES LIKE '$table'
 ALTER SCHEMA 'public' RENAME TO '$schema'
 EXCLUDING TABLE NAMES LIKE 'caplets_migrations', 'caplets_schema';

EOF
    loaded_tables="$loaded_tables$table "
  done
done
chmod 600 "$work/sqlite-data-only.load"

docker run --rm --network host \
  --mount "type=bind,src=$work,dst=/work" \
  "$PGLOADER_IMAGE" \
  pgloader /work/sqlite-data-only.load

for table in $source_tables; do
  source_count=$(sqlite3 "$work/source.sqlite3" "SELECT count(*) FROM \"$table\";")
  target_count=$(psql "$CAPLETS_TEST_POSTGRES_URL" -X -qAt -v ON_ERROR_STOP=1 \
    -c "SELECT count(*) FROM \"$schema\".\"$table\";")
  [ "$source_count" = "$target_count" ] || fail \
    "row count mismatch for $table (SQLite $source_count, PostgreSQL $target_count)"
  printf '%-48s %s\n' "$table" "$source_count"
done

compare_hash_projection() {
  label=$1
  sqlite_query=$2
  postgres_query=$3
  sqlite_projection=$(sqlite3 "$work/source.sqlite3" "$sqlite_query")
  postgres_projection=$(psql "$CAPLETS_TEST_POSTGRES_URL" -X -qAt -v ON_ERROR_STOP=1 \
    -c "$postgres_query")
  [ "$sqlite_projection" = "$postgres_projection" ] || fail \
    "durable content hash projection differs for $label"
  echo "verified durable content hashes: $label"
}

compare_hash_projection caplet_revisions \
  "SELECT revision_key, record_key, sequence, content_hash, ifnull(source_content_hash, '') FROM caplet_revisions ORDER BY revision_key;" \
  "SELECT revision_key, record_key, sequence, content_hash, coalesce(source_content_hash, '') FROM \"$schema\".caplet_revisions ORDER BY revision_key;"
compare_hash_projection caplet_asset_blobs \
  "SELECT hash, size, lower(hex(payload)), ifnull(object_key, ''), verification_status FROM caplet_asset_blobs ORDER BY hash;" \
  "SELECT hash, size, encode(payload, 'hex'), coalesce(object_key, ''), verification_status FROM \"$schema\".caplet_asset_blobs ORDER BY hash;"
compare_hash_projection caplet_bundle_entries \
  "SELECT revision_key, path, blob_hash, size FROM caplet_bundle_entries ORDER BY revision_key, path;" \
  "SELECT revision_key, path, blob_hash, size FROM \"$schema\".caplet_bundle_entries ORDER BY revision_key, path;"
compare_hash_projection caplet_installation_observations \
  "SELECT observation_key, ifnull(content_hash, '') FROM caplet_installation_observations ORDER BY observation_key;" \
  "SELECT observation_key, coalesce(content_hash, '') FROM \"$schema\".caplet_installation_observations ORDER BY observation_key;"

unvalidated_fks=$(psql "$CAPLETS_TEST_POSTGRES_URL" -X -qAt -v ON_ERROR_STOP=1 \
  -c "SELECT count(*) FROM pg_constraint WHERE connamespace = '$schema'::regnamespace AND contype = 'f' AND NOT convalidated;")
[ "$unvalidated_fks" = "0" ] || fail "PostgreSQL has $unvalidated_fks unvalidated foreign keys"

sequences=$(psql "$CAPLETS_TEST_POSTGRES_URL" -X -qAt -v ON_ERROR_STOP=1 \
  -c "SELECT count(*) FROM pg_class sequence JOIN pg_namespace namespace ON namespace.oid = sequence.relnamespace WHERE sequence.relkind = 'S' AND namespace.nspname = '$schema' AND NOT EXISTS (SELECT 1 FROM pg_depend dependency JOIN pg_class owner_table ON owner_table.oid = dependency.refobjid WHERE dependency.objid = sequence.oid AND owner_table.relname IN ('caplets_migrations', 'caplets_schema'));")
[ "$sequences" = "0" ] || fail \
  "target has $sequences sequences; run the release-specific identity reset procedure and verify next values"

echo "offline transfer verified; run 'caplets storage status --json' with the target runtime config before cutover"

#!/usr/bin/env bash
# Reads prod's platform D1 schema, read-only (prod-inspect.yml): the DDL in
# sqlite_master and the applied migrations in d1_migrations ("d1_migrations:
# absent" when sqlite_master has no such table). Job logs are public, so it
# runs only the two fixed statements below (allow_sql refuses any other
# before a request) and never reads a row or a count of any other table. It
# takes no SQL from args or env.
# The database is oa-p-platform, resolved by exact name (exactly one, every
# page). The token reaches curl on stdin (-K -), never argv; any API error,
# success != true or unparsable response exits 1 without it.
# Needs CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID.
# Usage: scripts/ci/prod-inspect.sh
set -euo pipefail

SCHEMA_SQL='SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name'
MIGRATIONS_SQL='SELECT id, name, applied_at FROM d1_migrations ORDER BY id'

# allow_sql <statement>: returns 0 only for exactly one of the two statements.
allow_sql() {
  [ "$#" -eq 1 ] || { echo "allow_sql: want one statement" >&2; return 1; }
  case "$1" in
    "$SCHEMA_SQL" | "$MIGRATIONS_SQL") return 0 ;;
    *) echo "refused: not an allowlisted statement" >&2; return 1 ;;
  esac
}
# Sourced by the test for allow_sql alone.
[ -z "${PROD_INSPECT_LIB:-}" ] || return 0

[ "$#" -eq 0 ] || { echo "usage: $0 (no arguments)" >&2; exit 2; }
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"
[[ "$CLOUDFLARE_ACCOUNT_ID" =~ ^[0-9a-f]{32}$ ]] || { echo "CLOUDFLARE_ACCOUNT_ID must be 32 hex" >&2; exit 2; }
# shellcheck source=scripts/ci/hosted-cf.sh
. "$(dirname "${BASH_SOURCE[0]}")/hosted-cf.sh"
ACCT="/accounts/$CLOUDFLARE_ACCOUNT_ID"

db=oa-p-platform
d1="$(list_all "$ACCT/d1/database?name=$db&" 100 "list D1 databases (for $db)")" || exit 1
id="$(one "$d1" name "$db" uuid "D1 database")" || exit 1
uuid='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
[[ "$id" =~ $uuid ]] || { echo "D1 database $db: its uuid is not a uuid" >&2; exit 1; }

# query <statement> <what>: the statement's rows as one JSON array.
query() {
  allow_sql "$1" || exit 1
  local body rows
  body="$(jq -nc --arg s "$1" '{sql: $s}')" || exit 1
  body="$(printf 'header = "Authorization: Bearer %s"\n' "$CLOUDFLARE_API_TOKEN" |
    curl -sS -K - -X POST -H 'Content-Type: application/json' --data-binary "$body" \
      "$CF$ACCT/d1/database/$id/query")" ||
    { echo "$2 failed: network error" >&2; exit 1; }
  if [ "$(jq -r '.success' <<< "$body" 2> /dev/null)" != true ]; then
    echo "$2 failed: $(jq -c '.errors' <<< "$body" 2> /dev/null || echo 'unparsable response')" >&2
    exit 1
  fi
  rows="$(jq -c 'if (.result | type) == "array" and (.result | length) == 1
      and .result[0].success == true and (.result[0].results | type) == "array"
    then .result[0].results else error("bad") end' <<< "$body" 2> /dev/null)" ||
    { echo "$2 failed: unexpected response shape" >&2; exit 1; }
  printf '%s' "$rows"
}

schema="$(query "$SCHEMA_SQL" "read sqlite_master")" || exit 1
has_migrations="$(jq -r 'any(.[]; .type == "table" and .name == "d1_migrations")' <<< "$schema")" || exit 1
if [ "$has_migrations" = true ]; then
  migrations="$(query "$MIGRATIONS_SQL" "read d1_migrations")" || exit 1
fi

echo "$db ($id)"
echo "sqlite_master:"
jq -c '.[]' <<< "$schema"
if [ "$has_migrations" = true ]; then
  echo "d1_migrations:"
  jq -c '.[]' <<< "$migrations"
else
  echo "d1_migrations: absent"
fi

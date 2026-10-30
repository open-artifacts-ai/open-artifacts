#!/usr/bin/env bash
# Loads one env's committed hosted constants (<dir>/<env>.json, normally
# .github/hosted) into $GITHUB_ENV: CLOUDFLARE_ACCOUNT_ID, EMAIL_ZONE_TAGS,
# EMAIL_DAILY_LIMIT, GOOGLE_CLIENT_ID, GOOGLE_DIRECTORY_CLIENT_ID. None is a
# secret. A missing, null, empty or multi-line value exits 1 and writes nothing.
# Usage: scripts/ci/hosted-constants.sh staging|prod <dir>
set -euo pipefail

[ "$#" -eq 2 ] || { echo "usage: $0 staging|prod <dir>" >&2; exit 2; }
case "$1" in staging | prod) ;; *) echo "env must be staging or prod" >&2; exit 2 ;; esac
file="$2/$1.json"
: "${GITHUB_ENV:?GITHUB_ENV is required}"
[ -f "$file" ] || { echo "$file is missing" >&2; exit 1; }

lines=""
for pair in account_id:CLOUDFLARE_ACCOUNT_ID email_zone_tags:EMAIL_ZONE_TAGS \
  email_daily_limit:EMAIL_DAILY_LIMIT google_client_id:GOOGLE_CLIENT_ID \
  google_directory_client_id:GOOGLE_DIRECTORY_CLIENT_ID; do
  k="${pair%%:*}"
  v="$(jq -r --arg k "$k" '.[$k] | if type == "string" or type == "number" then tostring else "" end' "$file")" || exit 1
  [ -n "$v" ] || { echo "$file: $k is missing" >&2; exit 1; }
  [[ "$v" != *$'\n'* && "$v" != *$'\r'* ]] || { echo "$file: $k spans lines" >&2; exit 1; }
  lines+="${pair#*:}=$v"$'\n'
done
[[ "$(jq -r '.account_id' "$file")" =~ ^[0-9a-f]{32}$ ]] || { echo "$file: account_id must be 32 hex" >&2; exit 1; }
printf '%s' "$lines" >> "$GITHUB_ENV"
printf '%s' "$lines"

#!/usr/bin/env bash
# Loads one env's committed hosted constants (<dir>/<env>.json, normally
# .github/hosted) into $GITHUB_ENV: CLOUDFLARE_ACCOUNT_ID, EMAIL_ZONE (the
# sending zone's name; hosted-resource-ids.sh resolves its tag),
# EMAIL_DAILY_LIMIT, GOOGLE_CLIENT_ID, GOOGLE_DIRECTORY_CLIENT_ID, and the
# provisioner's SIGNUP_DAILY_CAP, SIGNUPS_ENABLED and WELCOME_FROM. None is a
# secret. Every value is checked against its consumer's rule
# (deploy-platform-worker.sh) before anything is written: a missing, null,
# empty, multi-line or malformed value (a placeholder included) exits 1 and
# writes nothing.
# Usage: scripts/ci/hosted-constants.sh staging|prod <dir>
set -euo pipefail

[ "$#" -eq 2 ] || { echo "usage: $0 staging|prod <dir>" >&2; exit 2; }
case "$1" in staging | prod) ;; *) echo "env must be staging or prod" >&2; exit 2 ;; esac
file="$2/$1.json"
: "${GITHUB_ENV:?GITHUB_ENV is required}"
[ -f "$file" ] || { echo "$file is missing" >&2; exit 1; }

# deploy-platform-worker.sh's hex32, limit and google_id, and a zone name.
hex32='^[0-9a-f]{32}$'
zone='^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
limit='^[1-9][0-9]{0,8}$'
google_id='^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$'
# deploy-platform-worker.sh's cap, onoff (staging also test-users, design v7
# 7) and email.
cap='^[1-9][0-9]{0,3}$'
if [ "$1" = staging ]; then onoff='^(true|false|test-users)$'; else onoff='^(true|false)$'; fi
email='^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63})+$'
lines=""
# key ENV_NAME rule, one per line.
while read -r k name rule; do
  v="$(jq -r --arg k "$k" '.[$k] | if type == "string" or type == "number" then tostring else "" end' "$file")" || exit 1
  [ -n "$v" ] || { echo "$file: $k is missing" >&2; exit 1; }
  [[ "$v" != *$'\n'* && "$v" != *$'\r'* ]] || { echo "$file: $k spans lines" >&2; exit 1; }
  [[ "$v" =~ $rule ]] || { echo "$file: $k is not a valid value: $v" >&2; exit 1; }
  lines+="$name=$v"$'\n'
done << EOF
account_id CLOUDFLARE_ACCOUNT_ID $hex32
email_zone EMAIL_ZONE $zone
email_daily_limit EMAIL_DAILY_LIMIT $limit
google_client_id GOOGLE_CLIENT_ID $google_id
google_directory_client_id GOOGLE_DIRECTORY_CLIENT_ID $google_id
signup_daily_cap SIGNUP_DAILY_CAP $cap
signups_enabled SIGNUPS_ENABLED $onoff
welcome_from WELCOME_FROM $email
EOF
printf '%s' "$lines" >> "$GITHUB_ENV"
printf '%s' "$lines"

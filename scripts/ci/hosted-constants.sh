#!/usr/bin/env bash
# Loads one env's committed hosted constants (<dir>/<env>.json, normally
# .github/hosted) into $GITHUB_ENV: CLOUDFLARE_ACCOUNT_ID, EMAIL_ZONE (the
# sending zone's name; hosted-resource-ids.sh resolves its tag),
# EMAIL_DAILY_LIMIT, GOOGLE_CLIENT_ID, GOOGLE_DIRECTORY_CLIENT_ID, and the
# provisioner's and scheduler's SIGNUP_DAILY_CAP and SIGNUPS_ENABLED, the
# provisioner's WELCOME_FROM, and the scheduler's ALERT_FROM. None is a
# secret. Every value is checked against its consumer's rule
# (deploy-platform-worker.sh) before anything is written: a missing, null,
# empty, multi-line or malformed value (a placeholder included) exits 1 and
# writes nothing. The scheduler's ALERT_TO is the owner's address: never
# committed (#1084), it comes from OA_OWNER_EMAIL (the Actions secret) when
# set, goes to $GITHUB_ENV only and is never printed. Unset, no ALERT_TO is
# written, and a scheduler deploy refuses (deploy-hosted-platform.sh).
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
# 7; true needs ALLOW_SIGNUPS there, so it is never a committed constant) and
# email.
cap='^[1-9][0-9]{0,3}$'
if [ "$1" = staging ]; then onoff='^(false|test-users)$'; else onoff='^false$'; fi
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
alert_from ALERT_FROM $email
email_zone EMAIL_ZONE $zone
email_daily_limit EMAIL_DAILY_LIMIT $limit
google_client_id GOOGLE_CLIENT_ID $google_id
google_directory_client_id GOOGLE_DIRECTORY_CLIENT_ID $google_id
signup_daily_cap SIGNUP_DAILY_CAP $cap
signups_enabled SIGNUPS_ENABLED $onoff
welcome_from WELCOME_FROM $email
EOF
owner=""
if [ -n "${OA_OWNER_EMAIL:-}" ]; then
  [[ "$OA_OWNER_EMAIL" != *$'\n'* && "$OA_OWNER_EMAIL" =~ $email ]] || { echo "OA_OWNER_EMAIL is not a valid address" >&2; exit 1; }
  [[ ! "$OA_OWNER_EMAIL" =~ [[:upper:]] ]] || { echo "OA_OWNER_EMAIL must be lowercase" >&2; exit 1; }
  owner="ALERT_TO=$OA_OWNER_EMAIL"$'\n'
fi
printf '%s%s' "$lines" "$owner" >> "$GITHUB_ENV"
printf '%s' "$lines"

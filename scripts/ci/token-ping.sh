#!/usr/bin/env bash
# Pings one Cloudflare API token so its "Last used" time moves on the
# dashboard (token cleanup, #933/#934). Dispatched by token-ping.yml and
# token-ping-prod.yml, one job per secret. Prints only
#   id=<id> status=<status> kind=<user|account>
# never the token. Any failure prints only the HTTP code and exits 1.
# GETs only. The token reaches curl in a config on a process substitution,
# never argv.
# Env: TOKEN (the secret), HOSTED_DIR (holds <env>.json for the account id).
# Usage: scripts/ci/token-ping.sh <staging|prod>
set -euo pipefail

CF=https://api.cloudflare.com/client/v4

[ "$#" -eq 1 ] || { echo "usage: $0 <staging|prod>" >&2; exit 2; }
case "$1" in staging | prod) ENV="$1" ;; *) echo "unknown env: $1" >&2; exit 2 ;; esac
: "${TOKEN:?TOKEN is required}"
: "${HOSTED_DIR:?HOSTED_DIR is required}"
# Also keeps the curl config line well-formed (no quote, no newline).
[[ "$TOKEN" =~ ^[A-Za-z0-9._~+/=-]+$ ]] || { echo "the token is empty or has unexpected characters" >&2; exit 1; }

_auth() { printf 'header = "Authorization: Bearer %s"\n' "$TOKEN"; }

# get <path>: sets HTTP (code) and BODY. Never prints either.
get() {
  local out
  if out="$(curl -sS -X POST --max-time 30 -K <(_auth) -w $'\n%{http_code}' "$CF$1" 2> /dev/null)"; then
    HTTP="${out##*$'\n'}"
    BODY="${out%$'\n'*}"
  else
    HTTP=000
    BODY='{}'
  fi
  [[ "$HTTP" =~ ^[0-9]{3}$ ]] || HTTP=000
  jq -e . > /dev/null 2>&1 <<< "$BODY" || BODY='{}'
}

# answer <kind>: prints the line when this answer is a good one.
answer() {
  [ "$HTTP" = 200 ] || return 1
  local id status
  [ "$(jq -r '.success' <<< "$BODY")" = true ] || return 1
  id="$(jq -r '.result.id // ""' <<< "$BODY")"
  status="$(jq -r '.result.status // ""' <<< "$BODY")"
  [[ "$id" =~ ^[0-9a-f]{32}$ ]] || return 1
  [[ "$status" =~ ^[a-z_]{1,20}$ ]] || return 1
  echo "id=$id status=$status kind=$1"
}

get /user/tokens/verify
answer user && exit 0
FIRST="$HTTP"

# An auth error suggests an account-owned token: try the account's verify.
case "$FIRST" in
400 | 401 | 403)
  f="$HOSTED_DIR/$ENV.json"
  [ -f "$f" ] || { echo "http=$FIRST" >&2; exit 1; }
  account="$(jq -r '.account_id // ""' "$f")"
  [[ "$account" =~ ^[0-9a-f]{32}$ ]] || { echo "http=$FIRST" >&2; exit 1; }
  get "/accounts/$account/tokens/verify"
  answer account && exit 0
  echo "http=$HTTP" >&2
  exit 1
  ;;
esac
echo "http=$FIRST" >&2
exit 1

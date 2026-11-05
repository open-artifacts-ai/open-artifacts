#!/usr/bin/env bash
# The deploy token is the Environment's, not a repo-level fallback: before any
# Cloudflare read or write, ask Cloudflare who the token is and require it to
# be active and to be the one pinned as deploy_token_id in <env>.json.
# One GET (/user/tokens/verify). The token is read from $CLOUDFLARE_API_TOKEN
# into curl's config on a pipe (never argv) and is never printed; of the
# response only the id and status are shown.
# Usage: deploy-token-identity.sh <staging|prod> <hosted dir holding <env>.json>
set -euo pipefail

fail() {
  echo "::error title=Deploy token::$*" >&2
  exit 1
}

[ "$#" -eq 2 ] || { echo "usage: $0 <staging|prod> <hosted dir>" >&2; exit 2; }
case "$1" in staging | prod) env="$1" ;; *) echo "unknown env: $1" >&2; exit 2 ;; esac
f="$2/$env.json"

[ -f "$f" ] || fail "$f is missing"
pinned="$(jq -r '.deploy_token_id // ""' "$f")"
[[ "$pinned" =~ ^[0-9a-f]{32}$ ]] || fail "deploy_token_id is not pinned in $env.json"

tok="${CLOUDFLARE_API_TOKEN:-}"
[ -n "$tok" ] || fail "CLOUDFLARE_API_TOKEN is empty (the $env Environment has no such secret, or it was not passed)"
# Keeps the curl config line well-formed (no quote, no newline).
[[ "$tok" =~ ^[A-Za-z0-9._~+/=-]+$ ]] || fail "CLOUDFLARE_API_TOKEN has unexpected characters"

auth() { printf 'header = "Authorization: Bearer %s"\n' "$tok"; }

if out="$(curl -sS -K <(auth) -w $'\n%{http_code}' https://api.cloudflare.com/client/v4/user/tokens/verify 2> /dev/null)"; then
  http="${out##*$'\n'}"
  body="${out%$'\n'*}"
else
  http=000
  body='{}'
fi
jq -e . > /dev/null 2>&1 <<< "$body" || body='{}'

[ "$http" = 200 ] && [ "$(jq -r '.success' <<< "$body")" = true ] || fail "the token verify call failed (HTTP $http)"
id="$(jq -r '.result.id // ""' <<< "$body")"
status="$(jq -r '.result.status // ""' <<< "$body")"
[ "$status" = active ] || fail "the token is not active (status=${status:-none})"
[ "$id" = "$pinned" ] || fail "the token is not $env's deploy token (id=${id:-none}, pinned=$pinned)"
echo "Deploy token ok: id=$id status=$status"

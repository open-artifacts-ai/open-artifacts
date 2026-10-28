#!/usr/bin/env bash
# Deploys one hosted platform Worker of one env (staging or prod) from CI
# (deploy-hosted-platform.yml),
# with the same fill-and-verify rules as the runbook (docs/ops/hosted.md):
#   1. deploy through deploy-platform-worker.sh (allowlist, placeholders filled
#      and checked, `--env <env>`, never an entry point or --name);
#   2. secrets only after the Worker exists: Google client secrets from the
#      environment on every run (rotation is a re-run); the broker state keys
#      generated here on the first run only, never stored anywhere else;
#   3. read the deployed settings back and refuse on any mismatch.
# Secrets go to wrangler on stdin and the API token to curl on stdin (-K -):
# none is ever in argv or printed.
# VERIFY_ONLY=1 deploys and sets nothing: it only reads the live Worker back and
# runs every check (a read-only rehearsal against what is deployed).
# Usage (env as below): scripts/ops/deploy-hosted-platform.sh staging|prod <target>
#   auth-broker      BROKER_REGISTRY_ID GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET
#   directory-broker DIRECTORY_REGISTRY_ID GOOGLE_DIRECTORY_CLIENT_ID GOOGLE_DIRECTORY_CLIENT_SECRET
#   dispatch         HOSTS_KV_ID (both brokers must exist)
#   scheduler        PLATFORM_DB_ID EMAIL_ZONE_TAGS EMAIL_DAILY_LIMIT (both brokers must exist)
#   inventory-key    INVENTORY_KEY (sets oa-<p>-inventory's key; the Worker must exist)
# Always: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID.
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 staging|prod auth-broker|directory-broker|dispatch|scheduler|inventory-key" >&2
  exit 2
fi
env="$1"
target="$2"
case "$env" in
  staging) P=s; ZONE=open-artifacts-staging.app ;;
  prod) P=p; ZONE=open-artifacts.app ;;
  *) echo "env must be staging or prod" >&2; exit 2 ;;
esac
NS="oa-$env"
VERIFY_ONLY="${VERIFY_ONLY:-}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# The allowlisted deploy wrapper (tests swap in a stub).
wrapper="${DEPLOY_WRAPPER:-$root/scripts/ops/deploy-platform-worker.sh}"
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"
[[ "$CLOUDFLARE_ACCOUNT_ID" =~ ^[0-9a-f]{32}$ ]] || { echo "CLOUDFLARE_ACCOUNT_ID must be 32 hex" >&2; exit 2; }
ACCT="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID"

# A Cloudflare API GET; the token reaches curl on stdin, never argv.
cf_get() {
  printf 'header = "Authorization: Bearer %s"\n' "$CLOUDFLARE_API_TOKEN" |
    curl -sS -K - "$ACCT$1"
}
# The body, only when .success is true; else the errors (never a token) and exit 1.
must() {
  local body
  body="$(cat)"
  if [ "$(jq -r '.success' <<< "$body" 2> /dev/null)" != true ]; then
    echo "$1 failed: $(jq -c '.errors' <<< "$body" 2> /dev/null || echo 'unparsable response')" >&2
    exit 1
  fi
  printf '%s' "$body"
}
worker_exists() { [ "$(cf_get "/workers/scripts/$1/settings" | jq -r '.success' 2> /dev/null)" = true ]; }
need_workers() {
  for w in "$@"; do worker_exists "$w" || { echo "$w does not exist: deploy it first" >&2; exit 1; }; done
}
need() { # name: a required, non-empty env var
  [ -n "${!1:-}" ] || { echo "$1 is required for $target" >&2; exit 2; }
}
secret_names() { cf_get "/workers/scripts/$1/secrets" | must "list $1 secrets" | jq -r '.result[].name'; }
# put_secret <worker> <app dir> <name>: the value comes on stdin.
put_secret() {
  if [ -n "$VERIFY_ONLY" ]; then
    cat > /dev/null
    echo "$1: verify only, not setting $3"
    return
  fi
  (cd "$root/apps/$2" && pnpm exec wrangler secret put "$3" --env "$env" > /dev/null)
  echo "$1: $3 set"
}
# deploy <app>: through the wrapper, unless VERIFY_ONLY.
deploy() {
  if [ -n "$VERIFY_ONLY" ]; then echo "$target: verify only, not deploying"; return; fi
  bash "$wrapper" "$1" "$env"
}
settings() { cf_get "/workers/scripts/$1/settings" | must "read $1 settings"; }
# expect <settings json> <jq filter> <want> <what>
expect() {
  local got
  got="$(jq -r "$2" <<< "$1")"
  [ "$got" = "$3" ] || { echo "$4: got '$got', want '$3'" >&2; exit 1; }
}

case "$target" in
  auth-broker)
    need BROKER_REGISTRY_ID; need GOOGLE_CLIENT_ID; [ -n "$VERIFY_ONLY" ] || need GOOGLE_CLIENT_SECRET
    BROKER_REGISTRY_ID="$BROKER_REGISTRY_ID" GOOGLE_CLIENT_ID_PROD="$GOOGLE_CLIENT_ID" \
      deploy auth-broker
    printf '%s' "${GOOGLE_CLIENT_SECRET:-}" | put_secret oa-$P-auth-broker auth-broker GOOGLE_CLIENT_SECRET
    # Read first: a failed listing stops here, never reads as "absent" (which
    # would replace a live key).
    have="$(secret_names oa-$P-auth-broker)"
    if ! grep -qx BROKER_STATE_KEY <<< "$have"; then
      openssl rand -base64 32 | put_secret oa-$P-auth-broker auth-broker BROKER_STATE_KEY
    fi
    S="$(settings oa-$P-auth-broker)"
    expect "$S" '.result.bindings[] | select(.name == "BROKER_REGISTRY") | .namespace_id' "$BROKER_REGISTRY_ID" "BROKER_REGISTRY"
    expect "$S" '.result.bindings[] | select(.name == "GOOGLE_CLIENT_ID") | .text' "$GOOGLE_CLIENT_ID" "GOOGLE_CLIENT_ID"
    expect "$S" '.result.bindings[] | select(.name == "BROKER_ORIGIN") | .text' "https://auth.$ZONE" "BROKER_ORIGIN"
    expect "$S" '.result.observability.enabled // false' false "observability"
    names="$(secret_names oa-$P-auth-broker | sort | tr '\n' ' ')"
    [ "$names" = "BROKER_STATE_KEY GOOGLE_CLIENT_SECRET " ] || { echo "oa-$P-auth-broker secrets are '$names'" >&2; exit 1; }
    ;;
  directory-broker)
    need DIRECTORY_REGISTRY_ID; need GOOGLE_DIRECTORY_CLIENT_ID; [ -n "$VERIFY_ONLY" ] || need GOOGLE_DIRECTORY_CLIENT_SECRET
    DIRECTORY_REGISTRY_ID="$DIRECTORY_REGISTRY_ID" GOOGLE_DIRECTORY_CLIENT_ID_PROD="$GOOGLE_DIRECTORY_CLIENT_ID" \
      deploy directory-broker
    printf '%s' "${GOOGLE_DIRECTORY_CLIENT_SECRET:-}" | put_secret oa-$P-directory-broker directory-broker GOOGLE_DIRECTORY_CLIENT_SECRET
    # Read first: a failed listing stops here, never reads as "absent" (which
    # would replace a live key).
    have="$(secret_names oa-$P-directory-broker)"
    if ! grep -qx DIRECTORY_STATE_KEY <<< "$have"; then
      openssl rand -base64 32 | put_secret oa-$P-directory-broker directory-broker DIRECTORY_STATE_KEY
    fi
    S="$(settings oa-$P-directory-broker)"
    expect "$S" '.result.bindings[] | select(.name == "DIRECTORY_REGISTRY") | .namespace_id' "$DIRECTORY_REGISTRY_ID" "DIRECTORY_REGISTRY"
    expect "$S" '.result.bindings[] | select(.name == "GOOGLE_DIRECTORY_CLIENT_ID") | .text' "$GOOGLE_DIRECTORY_CLIENT_ID" "GOOGLE_DIRECTORY_CLIENT_ID"
    expect "$S" '.result.bindings[] | select(.name == "DIRECTORY_ORIGIN") | .text' "https://directory.$ZONE" "DIRECTORY_ORIGIN"
    expect "$S" '.result.observability.enabled // false' false "observability"
    names="$(secret_names oa-$P-directory-broker | sort | tr '\n' ' ')"
    [ "$names" = "DIRECTORY_STATE_KEY GOOGLE_DIRECTORY_CLIENT_SECRET " ] || { echo "oa-$P-directory-broker secrets are '$names'" >&2; exit 1; }
    ;;
  dispatch)
    need HOSTS_KV_ID
    need_workers oa-$P-auth-broker oa-$P-directory-broker
    HOSTS_KV_ID="$HOSTS_KV_ID" deploy dispatch
    S="$(settings oa-$P-dispatch)"
    expect "$S" '.result.bindings[] | select(.name == "HOSTS") | .namespace_id' "$HOSTS_KV_ID" "HOSTS"
    expect "$S" '.result.bindings[] | select(.name == "DISPATCHER") | .namespace' "$NS" "DISPATCHER"
    expect "$S" '.result.bindings[] | select(.name == "AUTH_BROKER") | .service' oa-$P-auth-broker "AUTH_BROKER"
    expect "$S" '.result.bindings[] | select(.name == "DIRECTORY_BROKER") | .service' oa-$P-directory-broker "DIRECTORY_BROKER"
    expect "$S" '.result.bindings[] | select(.name == "OA_ENV") | .text' "$env" "OA_ENV"
    expect "$S" '.result.observability.enabled // false' false "observability"
    ;;
  scheduler)
    need PLATFORM_DB_ID; need EMAIL_ZONE_TAGS; need EMAIL_DAILY_LIMIT
    need_workers oa-$P-auth-broker oa-$P-directory-broker
    PLATFORM_DB_ID="$PLATFORM_DB_ID" EMAIL_ZONE_TAGS="$EMAIL_ZONE_TAGS" EMAIL_DAILY_LIMIT="$EMAIL_DAILY_LIMIT" \
      deploy scheduler
    S="$(settings oa-$P-scheduler)"
    expect "$S" '.result.bindings[] | select(.name == "PLATFORM_DB") | .id' "$PLATFORM_DB_ID" "PLATFORM_DB"
    expect "$S" '.result.bindings[] | select(.name == "DISPATCHER") | .namespace' "$NS" "DISPATCHER"
    expect "$S" '.result.bindings[] | select(.name == "OA_ENV") | .text' "$env" "OA_ENV"
    expect "$S" '.result.bindings[] | select(.name == "EMAIL_QUOTA_ZONES") | .text' "$EMAIL_ZONE_TAGS" "EMAIL_QUOTA_ZONES"
    expect "$S" '.result.bindings[] | select(.name == "EMAIL_DAILY_LIMIT") | .text' "$EMAIL_DAILY_LIMIT" "EMAIL_DAILY_LIMIT"
    crons="$(cf_get /workers/scripts/oa-$P-scheduler/schedules | must "read oa-$P-scheduler schedules" | jq -r '[.result.schedules[].cron] | sort | join(",")')"
    [ "$crons" = "*/2 * * * *,17 3 * * *" ] || { echo "oa-$P-scheduler schedules are '$crons'" >&2; exit 1; }
    ;;
  inventory-key)
    need_workers oa-$P-inventory
    if [ -z "$VERIFY_ONLY" ]; then
      need INVENTORY_KEY
      [ "${#INVENTORY_KEY}" -ge 32 ] || { echo "INVENTORY_KEY must be at least 32 characters" >&2; exit 2; }
      (cd "$root/apps/inventory" && printf '%s' "$INVENTORY_KEY" | pnpm exec wrangler secret put INVENTORY_KEY --name "oa-$P-inventory" > /dev/null)
    fi
    have="$(secret_names oa-$P-inventory)"
    grep -qx INVENTORY_KEY <<< "$have" || { echo "oa-$P-inventory has no INVENTORY_KEY" >&2; exit 1; }
    echo "oa-$P-inventory: INVENTORY_KEY present"
    ;;
  *)
    echo "unknown target: $target" >&2
    exit 2
    ;;
esac
if [ -n "$VERIFY_ONLY" ]; then echo "$env $target: verified (verify only)"; else echo "$env $target: deployed and verified"; fi

#!/usr/bin/env bash
# Deploys one env of a platform Worker (docs/ops/hosted.md). The app must be in
# the allowlist below. Runs from the app's dir, fills this env's placeholders
# from environment variables into the gitignored wrangler.deploy.jsonc, refuses
# if any {{..._<ENV>}} is left, then runs `wrangler deploy --env <env>` with
# that copy: never a positional entry, never --name. The copy is removed on
# exit. Values are never echoed.
# Usage: <PLACEHOLDER VARS> scripts/ops/deploy-platform-worker.sh <app> staging|prod
#   auth-broker: BROKER_REGISTRY_ID=<32 hex> [GOOGLE_CLIENT_ID_PROD=<client id>, prod]
#   directory-broker: DIRECTORY_REGISTRY_ID=<32 hex> [GOOGLE_DIRECTORY_CLIENT_ID_PROD=<client id>, prod]
#   billing: BILLING_DB_ID=<D1 uuid> BROKER_REGISTRY_ID=<32 hex>
#   scheduler: PLATFORM_DB_ID=<uuid> EMAIL_ZONE_TAGS=<32 hex>[,...] (at most 10) EMAIL_DAILY_LIMIT=<1-9 digits>
#              OPS_ALERT_EMAIL=<address> OPS_ALERT_FROM=<address> SIGNUP_DAILY_CAP=<1-9999>
#   provisioner: SIGNUP_DAILY_CAP=<1-9999> WELCOME_FROM=<address> RELEASE_VERSION=<X.Y.Z>
#                CLOUDFLARE_ACCOUNT_ID=<32 hex> SECRETS_STORE_ID=<32 hex> PLATFORM_DB_ID=<uuid>
#                HOSTS_KV_ID=<32 hex> BROKER_REGISTRY_ID=<32 hex> DIRECTORY_REGISTRY_ID=<32 hex>
# Only the provisioner may bind the provision token (oa-<p>-provision-token),
# and it binds no other secret.
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <app> staging|prod" >&2
  exit 2
fi
app="$1"
env="$2"
case "$env" in
  staging) up=STAGING ;;
  prod) up=PROD ;;
  *)
    echo "env must be staging or prod" >&2
    exit 2
    ;;
esac

hex32='^[0-9a-f]{32}$'
google_id='^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$'
uuid='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
zones='^[0-9a-f]{32}(,[0-9a-f]{32}){0,9}$'
limit='^[1-9][0-9]{0,8}$'
# One plain address: no slash, ampersand, backslash, quote, comma or space, so
# it can't carry sed syntax or read as a list or display name.
# The signups admitted per UTC day: 1 to 9999, no leading zero.
cap='^[1-9][0-9]{0,3}$'
# A stable release version (no v, no pre-release).
version='^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$'
email='^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63})+$'

# The allowlist: app -> dir, plus the placeholders filled below.
case "$app" in
  auth-broker) dir=apps/auth-broker ;;
  directory-broker) dir=apps/directory-broker ;;
  billing) dir=apps/billing ;;
  scheduler) dir=apps/scheduler ;;
  provisioner) dir=apps/provisioner ;;
  *)
    echo "unknown app: not in the allowlist" >&2
    exit 2
    ;;
esac

cd "$(dirname "${BASH_SOURCE[0]}")/../../$dir"

copy=wrangler.deploy.jsonc
trap 'command rm -f "$copy" "$copy.bak"' EXIT

# fill <placeholder> <value> <regex>: the value must match, so it can't carry sed syntax.
fill() {
  if ! [[ "$2" =~ $3 ]]; then
    echo "value for {{$1}} is missing or malformed" >&2
    exit 1
  fi
  sed -i.bak "s/{{$1}}/$2/" "$copy"
  command rm -f "$copy.bak"
}

cp wrangler.jsonc "$copy"
case "$app" in
  auth-broker)
    fill "BROKER_REGISTRY_ID_${up}" "${BROKER_REGISTRY_ID:-}" "$hex32"
    # Prod's client id is a placeholder until a prod client exists: left
    # unset, the check below refuses.
    if [ "$env" = prod ] && [ -n "${GOOGLE_CLIENT_ID_PROD:-}" ]; then
      fill GOOGLE_CLIENT_ID_PROD "$GOOGLE_CLIENT_ID_PROD" "$google_id"
    fi
    ;;
  directory-broker)
    fill "DIRECTORY_REGISTRY_ID_${up}" "${DIRECTORY_REGISTRY_ID:-}" "$hex32"
    # Same as the auth broker: no prod Directory client yet, so unset refuses.
    if [ "$env" = prod ] && [ -n "${GOOGLE_DIRECTORY_CLIENT_ID_PROD:-}" ]; then
      fill GOOGLE_DIRECTORY_CLIENT_ID_PROD "$GOOGLE_DIRECTORY_CLIENT_ID_PROD" "$google_id"
    fi
    ;;
  billing)
    # The id of this env's D1 oa-<p>-billing.
    fill "BILLING_DB_ID_${up}" "${BILLING_DB_ID:-}" "$uuid"
    # The auth broker's registry namespace (read-only here): same variable,
    # same id as the auth-broker deploy.
    fill "BROKER_REGISTRY_ID_${up}" "${BROKER_REGISTRY_ID:-}" "$hex32"
    ;;
  scheduler)
    fill "PLATFORM_DB_ID_${up}" "${PLATFORM_DB_ID:-}" "$uuid"
    fill "EMAIL_ZONE_TAG_${up}" "${EMAIL_ZONE_TAGS:-}" "$zones"
    fill "EMAIL_DAILY_LIMIT_${up}" "${EMAIL_DAILY_LIMIT:-}" "$limit"
    # The operator alerts' recipient and sender (src/alerts.ts).
    fill "OPS_ALERT_EMAIL_${up}" "${OPS_ALERT_EMAIL:-}" "$email"
    fill "OPS_ALERT_FROM_${up}" "${OPS_ALERT_FROM:-}" "$email"
    # The same cap as the provisioner's (src/signups.ts re-enqueues under it).
    fill "SIGNUP_DAILY_CAP_${up}" "${SIGNUP_DAILY_CAP:-}" "$cap"
    ;;
  provisioner)
    fill "SIGNUP_DAILY_CAP_${up}" "${SIGNUP_DAILY_CAP:-}" "$cap"
    fill "WELCOME_FROM_${up}" "${WELCOME_FROM:-}" "$email"
    fill "RELEASE_VERSION_${up}" "${RELEASE_VERSION:-}" "$version"
    # The account wrangler deploys to is the one the Workflow provisions in.
    fill "ACCOUNT_ID_${up}" "${CLOUDFLARE_ACCOUNT_ID:-}" "$hex32"
    fill "SECRETS_STORE_ID_${up}" "${SECRETS_STORE_ID:-}" "$hex32"
    fill "PLATFORM_DB_ID_${up}" "${PLATFORM_DB_ID:-}" "$uuid"
    fill "HOSTS_KV_ID_${up}" "${HOSTS_KV_ID:-}" "$hex32"
    fill "BROKER_REGISTRY_ID_${up}" "${BROKER_REGISTRY_ID:-}" "$hex32"
    fill "DIRECTORY_REGISTRY_ID_${up}" "${DIRECTORY_REGISTRY_ID:-}" "$hex32"
    ;;
esac

# The provision token: bound by the provisioner and no other Worker. The
# provisioner binds exactly its two (one per env) and no other secret.
if [ "$app" = provisioner ]; then
  names=$(grep -Eo '"secret_name"[[:space:]]*:[[:space:]]*"[^"]*"' "$copy" | sed -E 's/.*"([^"]*)"$/\1/' | sort)
  if [ "$names" != "$(printf 'oa-p-provision-token\noa-s-provision-token')" ] ||
    [ "$(grep -c 'secret_name' "$copy")" -ne 2 ]; then
    echo "the provisioner may bind only oa-s-provision-token and oa-p-provision-token, once each, and no other secret" >&2
    exit 1
  fi
  # Each env block binds its own env's token, so a swapped pair is refused. A
  # line opening "staging": { or "prod": { starts that block.
  p=${env:0:1}
  bound=$(awk '
    match($0, /"(staging|prod)"[[:space:]]*:[[:space:]]*[{]/) {
      cur = substr($0, RSTART + 1, RLENGTH); sub(/".*/, "", cur)
    }
    {
      s = $0
      while (match(s, /"secret_name"[[:space:]]*:[[:space:]]*"[^"]*"/)) {
        n = substr(s, RSTART, RLENGTH); sub(/"$/, "", n); sub(/.*"/, "", n)
        print cur ":" n
        s = substr(s, RSTART + RLENGTH)
      }
    }' "$copy")
  if ! printf '%s\n' "$bound" | grep -qx "${env}:oa-${p}-provision-token"; then
    echo "the provisioner's ${env} block must bind oa-${p}-provision-token" >&2
    exit 1
  fi
elif grep -q 'provision-token' "$copy"; then
  echo "only the provisioner may bind the provision token (oa-<p>-provision-token)" >&2
  exit 1
fi

# Fail closed: no placeholder for this env may remain (comments included, so
# the check needs no JSONC parser).
if grep -Eq "\{\{[A-Z0-9_]*_${up}\}\}" "$copy"; then
  echo "a {{..._${up}}} placeholder is still unfilled in $copy:" >&2
  grep -Eo "\{\{[A-Z0-9_]*_${up}\}\}" "$copy" | sort -u >&2
  exit 1
fi

pnpm exec wrangler deploy -c "$copy" --env "$env"

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
#            STRIPE_PRICE_TEAM=<price_...> STRIPE_PRICE_BUSINESS=<price_...>
#   scheduler: PLATFORM_DB_ID=<uuid> EMAIL_ZONE_TAGS=<32 hex>[,...] (at most 10) EMAIL_DAILY_LIMIT=<1-9 digits>
#              OPS_ALERT_EMAIL=<address> OPS_ALERT_FROM=<address>
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
price='^price_[A-Za-z0-9]{1,255}$'
# One plain address: no slash, ampersand, backslash, quote, comma or space, so
# it can't carry sed syntax or read as a list or display name.
email='^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63})+$'

# The allowlist: app -> dir, plus the placeholders filled below.
case "$app" in
  auth-broker) dir=apps/auth-broker ;;
  directory-broker) dir=apps/directory-broker ;;
  billing) dir=apps/billing ;;
  scheduler) dir=apps/scheduler ;;
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
    # This env's Stripe test-mode price per paid plan (/checkout).
    fill "STRIPE_PRICE_TEAM_${up}" "${STRIPE_PRICE_TEAM:-}" "$price"
    fill "STRIPE_PRICE_BUSINESS_${up}" "${STRIPE_PRICE_BUSINESS:-}" "$price"
    ;;
  scheduler)
    fill "PLATFORM_DB_ID_${up}" "${PLATFORM_DB_ID:-}" "$uuid"
    fill "EMAIL_ZONE_TAG_${up}" "${EMAIL_ZONE_TAGS:-}" "$zones"
    fill "EMAIL_DAILY_LIMIT_${up}" "${EMAIL_DAILY_LIMIT:-}" "$limit"
    # The operator alerts' recipient and sender (src/alerts.ts).
    fill "OPS_ALERT_EMAIL_${up}" "${OPS_ALERT_EMAIL:-}" "$email"
    fill "OPS_ALERT_FROM_${up}" "${OPS_ALERT_FROM:-}" "$email"
    ;;
esac

# Fail closed: no placeholder for this env may remain (comments included, so
# the check needs no JSONC parser).
if grep -Eq "\{\{[A-Z0-9_]*_${up}\}\}" "$copy"; then
  echo "a {{..._${up}}} placeholder is still unfilled in $copy:" >&2
  grep -Eo "\{\{[A-Z0-9_]*_${up}\}\}" "$copy" | sort -u >&2
  exit 1
fi

pnpm exec wrangler deploy -c "$copy" --env "$env"

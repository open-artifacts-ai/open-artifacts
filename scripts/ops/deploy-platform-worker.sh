#!/usr/bin/env bash
# Deploys one env of a platform Worker (docs/ops/hosted.md). The app must be in
# the allowlist below. Runs from the app's dir, fills this env's placeholders
# from environment variables into the gitignored wrangler.deploy.jsonc, refuses
# if any placeholder but the other env's is left, then runs `wrangler deploy --env <env>` with
# that copy: never a positional entry, never --name. The copy is removed on
# exit. Values are never echoed.
# Usage: <PLACEHOLDER VARS> scripts/ops/deploy-platform-worker.sh <app> staging|prod
#   auth-broker: BROKER_REGISTRY_ID=<32 hex> [GOOGLE_CLIENT_ID_PROD=<client id>, prod]
#   directory-broker: DIRECTORY_REGISTRY_ID=<32 hex> [GOOGLE_DIRECTORY_CLIENT_ID_PROD=<client id>, prod]
#   dispatch: HOSTS_KV_ID=<32 hex>
#   scheduler: PLATFORM_DB_ID=<uuid> EMAIL_ZONE_TAGS=<32 hex>[,...] (at most 10) EMAIL_DAILY_LIMIT=<1-9 digits>
#              ALERT_TO=<address> (the vars and the pinned ALERT_EMAIL destination)
#              ALERT_FROM=<address> SIGNUP_DAILY_CAP=<1-9999> SIGNUPS_ENABLED=true|false (staging also test-users)
#   inventory: PLATFORM_DB_ID=<uuid> HOSTS_KV_ID=<32 hex> GITHUB_REPOSITORY_ID=<digits>
#   provisioner: SIGNUP_DAILY_CAP=<1-9999> SIGNUPS_ENABLED=true|false (staging also test-users)
#                WELCOME_FROM=<address> CLOUDFLARE_ACCOUNT_ID=<32 hex> SECRETS_STORE_ID=<32 hex>
#                PLATFORM_DB_ID=<uuid>
#   provisioning: PLATFORM_DB_ID=<uuid> PROVISIONING_OAUTH_KV_ID=<32 hex>
#                 GITHUB_REPOSITORY_ID=<digits> (the OIDC principal; only staging's
#                 block has one), and the admin build's dist-assets/index.html
#                 (deploy-hosted-platform.sh builds it first)
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
  staging) up=STAGING; other=PROD ;;
  prod) up=PROD; other=STAGING ;;
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
# The signups admitted per UTC day: 1 to 9999, no leading zero.
cap='^[1-9][0-9]{0,3}$'
# The signups gate: true or false; staging also test-users (design v7 7).
if [ "$env" = staging ]; then onoff='^(true|false|test-users)$'; else onoff='^(true|false)$'; fi
# One plain address: no slash, ampersand, backslash, quote, comma or space, so
# it can't carry sed syntax or read as a list or display name.
email='^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63})+$'
# A GitHub repository id: digits, no leading zero.
repo_id='^[1-9][0-9]{0,19}$'

# The allowlist: app -> dir, plus the placeholders filled below.
case "$app" in
  auth-broker) dir=apps/auth-broker ;;
  directory-broker) dir=apps/directory-broker ;;
  dispatch) dir=apps/dispatch ;;
  scheduler) dir=apps/scheduler ;;
  inventory) dir=apps/inventory ;;
  provisioner) dir=apps/provisioner ;;
  provisioning) dir=apps/provisioning ;;
  *)
    echo "unknown app: not in the allowlist" >&2
    exit 2
    ;;
esac

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here/../../$dir"

copy=wrangler.deploy.jsonc
trap 'command rm -f "$copy" "$copy.bak"' EXIT

# fill <placeholder> <value> <regex>: the value must match, so it can't carry sed syntax.
fill() {
  if ! [[ "$2" =~ $3 ]]; then
    echo "value for {{$1}} is missing or malformed" >&2
    exit 1
  fi
  sed -i.bak "s/{{$1}}/$2/g" "$copy"
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
  dispatch)
    fill "HOSTS_KV_ID_${up}" "${HOSTS_KV_ID:-}" "$hex32"
    ;;
  scheduler)
    fill "PLATFORM_DB_ID_${up}" "${PLATFORM_DB_ID:-}" "$uuid"
    fill "EMAIL_ZONE_TAG_${up}" "${EMAIL_ZONE_TAGS:-}" "$zones"
    fill "EMAIL_DAILY_LIMIT_${up}" "${EMAIL_DAILY_LIMIT:-}" "$limit"
    # The alerts (design v7 4.8): the vars and ALERT_EMAIL's pinned
    # destination share {{ALERT_TO_<ENV>}}. A config that doesn't hold this
    # env's placeholders in all of them is refused here, before wrangler, so
    # no fill is a silent no-op and no scheduler deploys unpinned.
    node --experimental-strip-types --no-warnings "$here/wrangler-env.ts" wrangler.jsonc "$env" alert-pins > /dev/null ||
      { echo "apps/scheduler/wrangler.jsonc doesn't pin the $env alerts; refusing" >&2; exit 1; }
    fill "ALERT_TO_${up}" "${ALERT_TO:-}" "$email"
    fill "ALERT_FROM_${up}" "${ALERT_FROM:-}" "$email"
    fill "SIGNUP_DAILY_CAP_${up}" "${SIGNUP_DAILY_CAP:-}" "$cap"
    fill "SIGNUPS_ENABLED_${up}" "${SIGNUPS_ENABLED:-}" "$onoff"
    ;;
  inventory)
    fill "PLATFORM_DB_ID_${up}" "${PLATFORM_DB_ID:-}" "$uuid"
    fill "HOSTS_KV_ID_${up}" "${HOSTS_KV_ID:-}" "$hex32"
    # The OIDC principal's repository (design v7 6.3).
    fill "GITHUB_REPOSITORY_ID_${up}" "${GITHUB_REPOSITORY_ID:-}" "$repo_id"
    ;;
  provisioner)
    fill "SIGNUP_DAILY_CAP_${up}" "${SIGNUP_DAILY_CAP:-}" "$cap"
    # Closed: each signup is acked and its row stays pending.
    fill "SIGNUPS_ENABLED_${up}" "${SIGNUPS_ENABLED:-}" "$onoff"
    fill "WELCOME_FROM_${up}" "${WELCOME_FROM:-}" "$email"
    # The account wrangler deploys to is the one the Workflows provision in.
    fill "ACCOUNT_ID_${up}" "${CLOUDFLARE_ACCOUNT_ID:-}" "$hex32"
    fill "SECRETS_STORE_ID_${up}" "${SECRETS_STORE_ID:-}" "$hex32"
    fill "PLATFORM_DB_ID_${up}" "${PLATFORM_DB_ID:-}" "$uuid"
    ;;
  provisioning)
    fill "PLATFORM_DB_ID_${up}" "${PLATFORM_DB_ID:-}" "$uuid"
    fill "PROVISIONING_OAUTH_KV_ID_${up}" "${PROVISIONING_OAUTH_KV_ID:-}" "$hex32"
    # Only staging has the OIDC principal (4.4); prod's block names no
    # repository, but the value is checked either way.
    fill "GITHUB_REPOSITORY_ID_${up}" "${GITHUB_REPOSITORY_ID:-}" "$repo_id"
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

# Fail closed: no placeholder may remain but the other env's (comments
# included, so the check needs no JSONC parser).
left=$(grep -Eo '\{\{[A-Z][A-Z0-9_]*\}\}' "$copy" | grep -Ev "_${other}\}\}$" | sort -u || true)
if [ -n "$left" ]; then
  echo "a placeholder is still unfilled in $copy:" >&2
  printf '%s\n' "$left" >&2
  exit 1
fi

# The provisioning Worker serves the admin build as ASSETS: never deploy
# without it (deploy-hosted-platform.sh runs the build first).
if [ "$app" = provisioning ] && [ ! -f dist-assets/index.html ]; then
  echo "$dir/dist-assets/index.html is missing: build @oa/admin... and @oa/provisioning... first" >&2
  exit 1
fi

pnpm exec wrangler deploy -c "$copy" --env "$env"

#!/usr/bin/env bash
# Deploys one env's auth broker (docs/ops/hosted.md). Always runs from
# apps/auth-broker. Fills the env's placeholders from environment variables
# into the gitignored wrangler.deploy.jsonc, refuses if any {{..._<ENV>}} is
# left, then runs `wrangler deploy --env <env>` with that copy: never a
# positional entry, never --name. The copy is removed on exit. Values are
# never echoed.
# Usage: BROKER_REGISTRY_ID=<kv id> [GOOGLE_CLIENT_ID_PROD=<id>] scripts/ops/deploy-broker.sh staging|prod
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: BROKER_REGISTRY_ID=<kv id> $0 staging|prod" >&2
  exit 2
fi
env="$1"
case "$env" in
  staging) up=STAGING ;;
  prod) up=PROD ;;
  *)
    echo "env must be staging or prod" >&2
    exit 2
    ;;
esac

cd "$(dirname "${BASH_SOURCE[0]}")/../../apps/auth-broker"

registry="${BROKER_REGISTRY_ID:-}"
if ! [[ "$registry" =~ ^[0-9a-f]{32}$ ]]; then
  echo "BROKER_REGISTRY_ID must be the 32-char hex id of oa-<p>-broker-registry" >&2
  exit 1
fi

copy=wrangler.deploy.jsonc
trap 'command rm -f "$copy"' EXIT

sed "s/{{BROKER_REGISTRY_ID_${up}}}/${registry}/" wrangler.jsonc > "$copy"

if [ "$env" = prod ]; then
  client="${GOOGLE_CLIENT_ID_PROD:-}"
  if [ -n "$client" ]; then
    if ! [[ "$client" =~ ^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$ ]]; then
      echo "GOOGLE_CLIENT_ID_PROD is not a Google client id" >&2
      exit 1
    fi
    sed -i.bak "s/{{GOOGLE_CLIENT_ID_PROD}}/${client}/" "$copy"
    command rm -f "$copy.bak"
  fi
fi

# Fail closed: no placeholder for this env may remain (comments included, so
# the check needs no JSONC parser).
if grep -Eq "\{\{[A-Z0-9_]*_${up}\}\}" "$copy"; then
  echo "a {{..._${up}}} placeholder is still unfilled in $copy" >&2
  grep -Eo "\{\{[A-Z0-9_]*_${up}\}\}" "$copy" | sort -u >&2
  exit 1
fi

pnpm exec wrangler deploy -c "$copy" --env "$env"

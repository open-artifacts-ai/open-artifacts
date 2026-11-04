#!/usr/bin/env bash
# The release one platform Worker runs: prints its "workers/tag" annotation
# (vX.Y.Z) on stdout. prod-release-chain.yml (#1343) reads the prod
# scheduler's, which is the fleet's target, to deploy only a newer tag.
# Read-only. The newest deployment must send 100% of traffic to one version,
# tagged with a release; a split, an untagged version, a non-release tag or
# any API error fails (exit 1) and prints nothing on stdout. No retry: a read
# that lags just after a deploy fails closed, and the chain halts. The token
# reaches curl on stdin (hosted-cf.sh), never argv.
# Usage: CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=<32 hex> scripts/ci/worker-tag.sh staging|prod <app>
set -euo pipefail

[ "$#" -eq 2 ] || { echo "usage: $0 staging|prod <app>" >&2; exit 2; }
case "$1" in
  staging) p=s ;;
  prod) p=p ;;
  *) echo "env must be staging or prod" >&2; exit 2 ;;
esac
case "$2" in
  auth-broker | directory-broker | provisioner | dispatch | scheduler | inventory | provisioning) ;;
  *) echo "app must be a platform Worker" >&2; exit 2 ;;
esac
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"
[[ "$CLOUDFLARE_ACCOUNT_ID" =~ ^[0-9a-f]{32}$ ]] || { echo "CLOUDFLARE_ACCOUNT_ID must be 32 hex" >&2; exit 2; }
# shellcheck source=scripts/ci/hosted-cf.sh
. "$(dirname "${BASH_SOURCE[0]}")/hosted-cf.sh"
w="oa-$p-$2"
acct="/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts"

body="$(cf_ok "$acct/$w/deployments" "$w: list deployments")" || exit 1
v="$(jq -r '
  (.result.deployments // []) | sort_by(.created_on) | last
  | if . == null then "none"
    elif (.versions | length) == 1 and .versions[0].percentage == 100 then .versions[0].version_id
    else "split" end' <<< "$body")" || { echo "$w: unparsable deployments" >&2; exit 1; }
[ "$v" != none ] || { echo "$w has no deployment" >&2; exit 1; }
[ "$v" != split ] || { echo "$w runs a split deployment, not one version at 100%" >&2; exit 1; }
[[ "$v" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || { echo "$w: unexpected version id" >&2; exit 1; }
ver="$(cf_ok "$acct/$w/versions/$v" "$w: read version ${v:0:8}")" || exit 1
got="$(jq -r '.result.annotations["workers/tag"] // "" | tostring' <<< "$ver")" || { echo "$w: unparsable version" >&2; exit 1; }
[[ "$got" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "$w runs version ${v:0:8}, not tagged with a release" >&2; exit 1; }
echo "$got"

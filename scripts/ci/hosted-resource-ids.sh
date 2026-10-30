#!/usr/bin/env bash
# Resolves one env's platform resource ids from the hosted account at run time
# (deploy-hosted-platform.yml), so nobody copies ids into the Environment:
#   PLATFORM_DB_ID         D1 oa-<p>-platform (its uuid)
#   HOSTS_KV_ID            KV oa-<p>-hosts
#   BROKER_REGISTRY_ID     KV oa-<p>-broker-registry
#   DIRECTORY_REGISTRY_ID  KV oa-<p>-directory-registry
#   EMAIL_ZONE_TAGS        the id of the sending zone $EMAIL_ZONE, on this account
# (names from packages/provision/src/names.ts, platformNames; EMAIL_ZONE from
# .github/hosted/<env>.json). Each must match exactly one resource by exact
# name: 0 or 2+, a failed call or a network error exits 1 naming it, and
# nothing is written. All five go to $GITHUB_ENV.
# Needs CLOUDFLARE_API_TOKEN (to curl on stdin), CLOUDFLARE_ACCOUNT_ID,
# EMAIL_ZONE, GITHUB_ENV.
# Usage: scripts/ci/hosted-resource-ids.sh staging|prod
set -euo pipefail

[ "$#" -eq 1 ] || { echo "usage: $0 staging|prod" >&2; exit 2; }
case "$1" in
  staging) P=s ;;
  prod) P=p ;;
  *) echo "env must be staging or prod" >&2; exit 2 ;;
esac
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"
[[ "$CLOUDFLARE_ACCOUNT_ID" =~ ^[0-9a-f]{32}$ ]] || { echo "CLOUDFLARE_ACCOUNT_ID must be 32 hex" >&2; exit 2; }
: "${GITHUB_ENV:?GITHUB_ENV is required}"
: "${EMAIL_ZONE:?EMAIL_ZONE is required}"
[[ "$EMAIL_ZONE" =~ ^[a-z0-9.-]+$ ]] || { echo "EMAIL_ZONE is not a zone name" >&2; exit 2; }
# shellcheck source=scripts/ci/hosted-cf.sh
. "$(dirname "${BASH_SOURCE[0]}")/hosted-cf.sh"
ACCT="/accounts/$CLOUDFLARE_ACCOUNT_ID"

db="oa-$P-platform"
kvs=("oa-$P-hosts" "oa-$P-broker-registry" "oa-$P-directory-registry")
d1="$(list_all "$ACCT/d1/database?" 100 "list D1 databases (for $db)")" || exit 1
kv="$(list_all "$ACCT/storage/kv/namespaces?" 100 "list KV namespaces (for ${kvs[*]})")" || exit 1
# Account-scoped twice: in the query and on each result.
zones="$(list_all "/zones?name=$EMAIL_ZONE&account.id=$CLOUDFLARE_ACCOUNT_ID&" 50 "look up zone $EMAIL_ZONE")" || exit 1
zones="$(jq -c --arg a "$CLOUDFLARE_ACCOUNT_ID" '[.[] | select(.account.id == $a)]' <<< "$zones")" || exit 1

uuid='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
hex32='^[0-9a-f]{32}$'
PLATFORM_DB_ID="$(one "$d1" name "$db" uuid "D1 database")" || exit 1
[[ "$PLATFORM_DB_ID" =~ $uuid ]] || { echo "D1 database $db: its uuid is not a uuid" >&2; exit 1; }
ids=()
for n in "${kvs[@]}"; do
  id="$(one "$kv" title "$n" id "KV namespace")" || exit 1
  [[ "$id" =~ $hex32 ]] || { echo "KV namespace $n: its id is not 32 hex" >&2; exit 1; }
  ids+=("$id")
done
EMAIL_ZONE_TAGS="$(one "$zones" name "$EMAIL_ZONE" id "zone")" || exit 1
[[ "$EMAIL_ZONE_TAGS" =~ $hex32 ]] || { echo "zone $EMAIL_ZONE: its id is not 32 hex" >&2; exit 1; }

# Only once all five resolved. Ids are not secrets.
{
  echo "PLATFORM_DB_ID=$PLATFORM_DB_ID"
  echo "HOSTS_KV_ID=${ids[0]}"
  echo "BROKER_REGISTRY_ID=${ids[1]}"
  echo "DIRECTORY_REGISTRY_ID=${ids[2]}"
  echo "EMAIL_ZONE_TAGS=$EMAIL_ZONE_TAGS"
} >> "$GITHUB_ENV"
echo "$db: $PLATFORM_DB_ID"
for i in 0 1 2; do echo "${kvs[$i]}: ${ids[$i]}"; done
echo "$EMAIL_ZONE: $EMAIL_ZONE_TAGS"

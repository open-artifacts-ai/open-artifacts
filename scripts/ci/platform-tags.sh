#!/usr/bin/env bash
# One version everywhere (#1040): every platform Worker of one env runs exactly
# the release <tag>. Read-only. For each Worker, the newest deployment must
# send 100% of traffic to one version, and that version's "workers/tag"
# annotation (wrangler deploy --tag, set by deploy-platform-worker.sh) must be
# <tag>. Any API error, a split deployment, an untagged version or another tag
# fails (exit 1), naming the Worker and what it runs; each match prints one ok
# line. The token reaches curl on stdin (hosted-cf.sh), never argv.
# Cloudflare reads lag just after a deploy (#1327): a version read that answers
# 100146 (version not found) or a newest version tagged with another release
# is retried, one stderr line per retry, up to PLATFORM_TAGS_ATTEMPTS times
# (default 6) PLATFORM_TAGS_SLEEP seconds apart (default 10), then fails as
# above. Every other failure is final at once.
# Usage: CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=<32 hex> scripts/ci/platform-tags.sh staging|prod vX.Y.Z
set -euo pipefail

[ "$#" -eq 2 ] || { echo "usage: $0 staging|prod vX.Y.Z" >&2; exit 2; }
case "$1" in
  staging) p=s ;;
  prod) p=p ;;
  *) echo "env must be staging or prod" >&2; exit 2 ;;
esac
tag="$2"
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "tag must be a stable vX.Y.Z" >&2; exit 2; }
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"
[[ "$CLOUDFLARE_ACCOUNT_ID" =~ ^[0-9a-f]{32}$ ]] || { echo "CLOUDFLARE_ACCOUNT_ID must be 32 hex" >&2; exit 2; }
attempts="${PLATFORM_TAGS_ATTEMPTS:-6}"
pause="${PLATFORM_TAGS_SLEEP:-10}"
[[ "$attempts" =~ ^[1-9][0-9]?$ ]] || { echo "PLATFORM_TAGS_ATTEMPTS must be 1 to 99" >&2; exit 2; }
[[ "$pause" =~ ^[0-9]{1,3}$ ]] || { echo "PLATFORM_TAGS_SLEEP must be 0 to 999 seconds" >&2; exit 2; }
# shellcheck source=scripts/ci/hosted-cf.sh
. "$(dirname "${BASH_SOURCE[0]}")/hosted-cf.sh"
acct="/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts"

uuid='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
lag=3
# check_once <worker>: its ok line (exit 0), or what it runs (exit 1; exit $lag
# when that may be read lag), all on stdout. It runs in a subshell, so cf_ok's
# exit on an API error ends only this attempt; set -e is off there (an `if`
# condition), so every step checks itself.
check_once() {
  local w="$1" body v ver got rc
  exec 2>&1 # cf_ok and jq messages join the attempt's output
  body="$(cf_ok "$acct/$w/deployments" "$w: list deployments")" || exit 1
  # The newest deployment is the one serving traffic.
  v="$(jq -r '
    (.result.deployments // []) | sort_by(.created_on) | last
    | if . == null then "none"
      elif (.versions | length) == 1 and .versions[0].percentage == 100 then .versions[0].version_id
      else "split" end' <<< "$body")" || { echo "$w: unparsable deployments"; exit 1; }
  [ "$v" != none ] || { echo "$w has no deployment"; exit 1; }
  [ "$v" != split ] || { echo "$w runs a split deployment, not one version at 100%"; exit 1; }
  [[ "$v" =~ $uuid ]] || { echo "$w: unexpected version id"; exit 1; }
  # 100146: the version is not readable yet, though a deployment names it.
  ver="$(cf_ok "$acct/$w/versions/$v" "$w: read version ${v:0:8}" 100146)"
  rc=$?
  [ "$rc" = 0 ] || { [ "$rc" = "$lag" ] && exit "$lag"; exit 1; }
  got="$(jq -r '.result.annotations["workers/tag"] // "" | tostring' <<< "$ver")" || { echo "$w: unparsable version"; exit 1; }
  [ -n "$got" ] || { echo "$w runs untagged version ${v:0:8}"; exit 1; }
  if [ "$got" != "$tag" ]; then
    # Echo only a tag-shaped value: anything else is named, not printed.
    if [[ "$got" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      # Another release: the deployments list may not show the new one yet.
      echo "$w runs $got (version ${v:0:8}), not $tag"
      exit "$lag"
    fi
    echo "$w runs version ${v:0:8} tagged with something other than a release, not $tag"
    exit 1
  fi
  echo "ok $w runs $tag (version ${v:0:8})"
}

# check <worker>: its ok line, or names what it runs on stderr and exits 1,
# after retrying read lag (one stderr line per retry).
check() {
  local w="$1" a out rc
  for ((a = 1; ; a++)); do
    out="$(check_once "$w")" && rc=0 || rc=$?
    [ "$rc" != 0 ] || { printf '%s\n' "$out"; return 0; }
    if [ "$rc" = "$lag" ] && [ "$a" -lt "$attempts" ]; then
      echo "retry $w: attempt $a of $attempts saw read lag ($out); again in ${pause} s" >&2
      sleep "$pause"
      continue
    fi
    printf '%s\n' "$out" >&2
    return 1
  done
}

bad=0
for app in auth-broker directory-broker provisioner dispatch scheduler inventory provisioning; do
  if line="$(check "oa-$p-$app")"; then echo "$line"; else bad=1; fi
done
[ "$bad" = 0 ] || { echo "platform Workers in $1 are not all on $tag: deploy $tag to every target (deploy-hosted-platform.yml)" >&2; exit 1; }

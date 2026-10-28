#!/usr/bin/env bash
# Puts a release candidate on the red-line staging installs, the standard step
# before the final gate (T19): publish the tag's staging release (signed,
# verified), upgrade rl-a (and rl-b with --with-rl-b) to it, then require each
# install's /healthz to report that version and its own install id. An upgrade
# keeps the install's data (T19's fixed t19- spaces survive). The gate then
# checks the same: rl-a /healthz version == the tag.
# Usage: CLOUDFLARE_ACCOUNT_ID=<hosted account> scripts/ops/redline-deploy.sh vX.Y.Z [--with-rl-b]
# The staging provisioning token comes from the keychain (oa:hosted); never printed.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

tag="${1:-}"
if ! [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "usage: $0 vX.Y.Z [--with-rl-b]" >&2
  exit 2
fi
case "${2:-}" in
  "") targets=(rl-a) ;;
  --with-rl-b) targets=(rl-a rl-b) ;;
  *)
    echo "usage: $0 vX.Y.Z [--with-rl-b]" >&2
    exit 2
    ;;
esac
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID (the hosted account) is required}"
version="${tag#v}"
# The red-line installs (staging, test hooks). Overridable for tests only.
id_of() {
  case "$1" in
    rl-a) echo "${RL_A_ID:-ijzbmraouh5r}" ;;
    rl-b) echo "${RL_B_ID:-i42fdk7ahvs2}" ;;
  esac
}
host_of() { echo "$1.${RL_ZONE:-open-artifacts-staging.app}"; }

# One oa:hosted step; succeed only on its {"step":<step>,"status":"ok"} line.
hosted() {
  local step="$1"
  shift
  local out
  out="$(cd "$root" && pnpm -s oa:hosted "$step" --env staging "$@" 2>&1)" || true
  if grep -q "\"step\":\"$step\",\"status\":\"ok\"" <<< "$out"; then return 0; fi
  # Already there is fine: someone (or a rerun) got there first. A published
  # release is never overwritten, so the one in staging is this tag's.
  if [ "$step" = upgrade ] && grep -q "is already at $version" <<< "$out"; then return 0; fi
  if [ "$step" = publish-release ] && grep -q "release $version (release) is already published" <<< "$out"; then return 0; fi
  grep -E '"status":"error"' <<< "$out" | cut -c1-300 >&2 || true
  return 1
}

echo "redline-deploy: publishing $tag to staging"
hosted publish-release --tag "$tag" || {
  echo "redline-deploy: publish-release $tag failed" >&2
  exit 1
}
for t in "${targets[@]}"; do
  id="$(id_of "$t")"
  echo "redline-deploy: upgrading $t ($id) to $version"
  hosted upgrade --install "$id" --to "$version" || {
    echo "redline-deploy: upgrading $t failed" >&2
    exit 1
  }
done
fail=0
for t in "${targets[@]}"; do
  id="$(id_of "$t")"
  # shellcheck disable=SC2016 # single-quoted JS template, expanded by node
  got="$(curl -fsS -m 20 "https://$(host_of "$t")/healthz" |
    node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(`${d.version} ${d.installId}`)')" || got="unreachable"
  if [ "$got" = "$version $id" ]; then
    echo "redline-deploy: $t at $version (install $id)"
  else
    echo "redline-deploy: $t reports \"$got\", not \"$version $id\"" >&2
    fail=1
  fi
done
exit "$fail"

#!/usr/bin/env bash
# UI screenshots for a contributor PR, on the dashboard's mock API at a fixed
# port. One exact command, so the leads' permission rule can name this script
# instead of a wide playwright pattern (follow-up to #1814).
#
# Threat model: this narrows the command line, not the code. The spec, the
# playwright and vite configs and node_modules all run as Node with your
# privileges and network, exactly as `pnpm exec playwright test` would. Only run
# specs and diffs you have read; fork code is ported into our own branch first,
# never checked out and run as is. The browser's API calls go to MSW
# (VITE_MOCK=1; an unmocked call falls through to a local wrangler dev on
# :8787 if one is running, so stop it first). The Node side starts with a
# scrubbed environment (HOME, PATH, TERM, LANG, plus browser path, temp dir,
# CA and proxy vars when set), so session tokens in env vars do not reach it.
# HOME is kept, so credentials stored in files (~/.config/gh, ~/.npmrc, ...)
# are still readable: this is not a sandbox.
#
# Usage: scripts/contrib-shots.sh <name>
#   Runs apps/dashboard/e2e/<name>-shots.spec.ts and prints the PNGs it wrote
#   (also after a failing run, then exits with the run's status).
#   <name> is lowercase letters, digits and single dashes (e.g. pr-1660).
#   Needs `pnpm install --frozen-lockfile` in this checkout first.
#   OA_SHOTS_DRY_RUN=1 prints the command instead of running it.
set -euo pipefail

PORT=5299

usage() {
  echo "usage: $0 <name>   (runs apps/dashboard/e2e/<name>-shots.spec.ts)" >&2
  exit 64
}

[[ $# -eq 1 ]] || usage
name="$1"
[[ "$name" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] || usage

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
dash="$root/apps/dashboard"
spec="e2e/$name-shots.spec.ts"
base="$dash/test-results/contrib-shots"
out="$base/$name"

if [[ ! -f "$dash/$spec" ]]; then
  echo "no such spec: apps/dashboard/$spec" >&2
  exit 66
fi

# Playwright reads the file argument as a regex over the absolute path.
filter="e2e/$name-shots\\.spec\\.ts\$"
cmd=(pnpm --dir "$dash" exec playwright test "$filter" --output "$out" --reporter line)
clean_env=(env -i "HOME=$HOME" "PATH=$PATH" "TERM=${TERM:-dumb}" "LANG=${LANG:-C}")
for v in PLAYWRIGHT_BROWSERS_PATH TMPDIR NODE_EXTRA_CA_CERTS \
  HTTPS_PROXY HTTP_PROXY NO_PROXY https_proxy http_proxy no_proxy; do
  if [[ -n "${!v:-}" ]]; then clean_env+=("$v=${!v}"); fi
done
clean_env+=(VITE_MOCK=1 "OA_E2E_PORT=$PORT")

if [[ "${OA_SHOTS_DRY_RUN:-}" == "1" ]]; then
  printf '%q ' "${clean_env[@]}" "${cmd[@]}"
  echo
  exit 0
fi

if [[ ! -d "$root/node_modules" ]]; then
  echo "no node_modules: run pnpm install --frozen-lockfile in $root first" >&2
  exit 69
fi

# Clear only our own output dir: refuse if any part of it resolves elsewhere,
# checking each level before creating it.
p="$dash"
for part in test-results contrib-shots; do
  p="$p/$part"
  if [[ -L "$p" ]]; then
    echo "refusing: $p is a symlink" >&2
    exit 73
  fi
  if [[ ! -d "$p" ]]; then mkdir "$p"; fi
done
if [[ "$(cd "$base" && pwd -P)" != "$base" ]]; then
  echo "refusing: $base resolves outside the checkout (symlink?)" >&2
  exit 73
fi
if [[ -L "$out" ]]; then
  echo "refusing: $out is a symlink" >&2
  exit 73
fi
rm -rf "$out"

status=0
"${clean_env[@]}" "${cmd[@]}" || status=$?
if [[ -d "$out" ]]; then
  find "$out" -name '*.png' | sort
fi
exit "$status"

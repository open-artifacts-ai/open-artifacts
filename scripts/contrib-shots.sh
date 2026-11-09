#!/usr/bin/env bash
# UI screenshots for a contributor PR, on the dashboard's mock API (MSW, no
# server, no secrets) at a fixed port. One exact command, so the leads'
# permission rule can name this script instead of a wide playwright pattern
# (follow-up to #1814).
#
# Usage: scripts/contrib-shots.sh <name>
#   Runs apps/dashboard/e2e/<name>-shots.spec.ts and prints the PNGs it wrote.
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
out="$dash/test-results/contrib-shots/$name"

if [[ ! -f "$dash/$spec" ]]; then
  echo "no such spec: apps/dashboard/$spec" >&2
  exit 66
fi

cmd=(pnpm --dir "$dash" exec playwright test "$spec" --output "$out" --reporter line)

if [[ "${OA_SHOTS_DRY_RUN:-}" == "1" ]]; then
  echo "VITE_MOCK=1 OA_E2E_PORT=$PORT ${cmd[*]}"
  exit 0
fi

if [[ ! -d "$root/node_modules" ]]; then
  echo "no node_modules: run pnpm install --frozen-lockfile in $root first" >&2
  exit 69
fi

rm -rf "$out"
VITE_MOCK=1 OA_E2E_PORT=$PORT "${cmd[@]}"
find "$out" -name '*.png' | sort

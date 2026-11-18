#!/usr/bin/env bash
# Does this pull request reach the browser suites (#965 follow-up)? Writes
# run=true or run=false to GITHUB_OUTPUT for the e2e shards.
#
# The browser suites drive @oa/dashboard against a mock API and against a
# local @oa/server, plus the @oa/ui and @oa/landing checks. pnpm's
# `--filter ...[base]` lists each changed package and its dependents, so a
# change anywhere those apps import from lists one of them. That graph is
# complete because every cross-package import is declared
# (scripts/ci/workspace-imports.ts check, in the root suite).
#
# run=false only on proof: a pull request, with a base, whose scope is
# "affected" and whose affected list parses and names none of E2E. Every
# other event (the merge queue, a dispatch), a root config, lockfile,
# workflow or ROOT_PATHS change, a change to a root file pnpm places in the
# root package, and any error say run=true. The workflow gates on
# run != 'false', so a missing output also runs.
#   GITHUB_EVENT_NAME, BASE_SHA (the pull request's base), GITHUB_OUTPUT.
set -uo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
E2E=(open-artifacts @oa/dashboard @oa/server @oa/ui @oa/landing)

decide() {
  echo "run=$1" >> "${GITHUB_OUTPUT:-/dev/null}"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    echo "### e2e: $([ "$1" = true ] && echo runs || echo "not affected, skipped") ($2)" >> "$GITHUB_STEP_SUMMARY"
  fi
  echo "e2e: run=$1 ($2)"
  exit 0
}

[ "${GITHUB_EVENT_NAME:-}" = pull_request ] || decide true "${GITHUB_EVENT_NAME:-no event}"
[ -n "${BASE_SHA:-}" ] || decide true "no base sha"
if ! scope="$(node --experimental-strip-types --no-warnings "$root/scripts/ci/workspace-imports.ts" scope "$BASE_SHA")"; then
  decide true "the scope check failed"
fi
[ "$scope" = affected ] || decide true "a root config, lockfile, workflow or shared root path changed"
if ! listed="$(pnpm --filter "...[$BASE_SHA]" ls --depth -1 --json)"; then
  decide true "pnpm could not list the affected packages"
fi
if ! names="$(node -e 'const a=JSON.parse(require("fs").readFileSync(0,"utf8")||"[]");if(!Array.isArray(a))process.exit(1);for(const p of a){if(typeof p.name!=="string")process.exit(1);console.log(p.name)}' <<< "$listed")"; then
  decide true "the affected list did not parse"
fi
while IFS= read -r p; do
  [ -n "$p" ] || continue
  for e in "${E2E[@]}"; do
    [ "$p" = "$e" ] && decide true "$p is affected"
  done
done <<< "$names"
decide false "no browser-suite package is affected"
